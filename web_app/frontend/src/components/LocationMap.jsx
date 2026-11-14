import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatClockTime } from '../utils/dateUtils';

const mapContainerStyle = {
  width: '100%',
  height: '300px',
  borderRadius: '8px'
};

// Leaflet and OpenStreetMap tiles, not the Google Maps JavaScript API.
//
// The Google version rendered "This page can't load Google Maps correctly" --
// the key was well-formed and reached Google, and Google refused it: the
// browser key's project needs the Maps JavaScript API enabled, a billing
// account attached, and every origin the app is served from listed as an
// allowed referrer. That last one is the reason this is not worth keeping: the
// list would need the deployment's domain added before judges ever open it,
// and a forgotten entry breaks the map with no warning on the one day it has
// to work.
//
// NOTHING ON MOBILE CHANGED. The elderly user's "take me home", the memory
// view's "show on map" and the caregiver's directions all hand a
// maps/dir or maps/search URL to launchUrl() and let the Google Maps app do
// the work, including its own voice navigation -- no API, no key, no SDK, so
// no configuration can break them. The phone's embedded maps stay on
// google_maps_flutter with the Android key, which is a different key in a
// working project.
//
// WHERE THE TILES COME FROM, in order of precedence.
//
// 1. VITE_MAPTILER_KEY  -- paste the key alone, nothing else. The URL and the
//    credit line are built from it below, which is the point: MapTiler's
//    licence requires its attribution AND OpenStreetMap's, and an attribution
//    left to a second environment variable is an attribution someone forgets.
//    Leaflet will not warn you, and a basemap without its credit line is a
//    licence breach rather than a cosmetic slip. Free tier, no card, 100k tile
//    requests a month: cloud.maptiler.com -> Account -> API keys.
//
// 2. VITE_MAP_TILE_URL (+ VITE_MAP_TILE_ATTRIBUTION) -- the escape hatch for
//    any other host or a self-hosted cache. Here the attribution IS yours to
//    get right, because only you know what that host demands.
//
// 3. OpenStreetMap's volunteer servers -- the fallback, and NOT a deployment
//    setting. That is donated hardware, not a CDN, and the Tile Usage Policy
//    refuses production basemaps outright. One caregiver reading one 300px map
//    is inside what the policy calls modest use (its bar for "heavy" is
//    hundreds of thousands of tiles a day), which is the only reason this is
//    an honest fallback for a demonstration and dishonest for real households.
//
// Three technical rules hold whatever the host, because they are good manners
// anywhere: ONE HOSTNAME -- the a/b/c subdomain split is deprecated, since the
// servers speak HTTP/2 where a single connection multiplexes every tile and
// sharding only buys extra handshakes; NO ZOOM BEYOND WHAT WE DRAW, because a
// request for a tile that does not exist still costs the server the request;
// and detectRetina OFF, so a 300px map nobody reads at pixel level cannot
// quietly ask for four times the tiles.
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const MAPTILER_ATTRIBUTION =
  '<a href="https://www.maptiler.com/copyright/">&copy; MapTiler</a> ' + OSM_ATTRIBUTION;

const [TILE_URL, TILE_ATTRIBUTION] =
  MAPTILER_KEY
    ? [`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
       MAPTILER_ATTRIBUTION]
  : import.meta.env.VITE_MAP_TILE_URL
    ? [import.meta.env.VITE_MAP_TILE_URL,
       import.meta.env.VITE_MAP_TILE_ATTRIBUTION || OSM_ATTRIBUTION]
    : [OSM_TILE_URL, OSM_ATTRIBUTION];

const TILE_MAX_ZOOM = Number(import.meta.env.VITE_MAP_TILE_MAX_ZOOM) || 19;

// A floor under zoom-out. Each level out quadruples the tiles on screen, and a
// caregiver answering "where is she now" never needs a view of the continent --
// city level is already past useful. Without this, one pinch fetches hundreds
// of tiles in a burst, which is both the fastest way to get rate-limited by a
// tile host and a worse map to read.
const TILE_MIN_ZOOM = 10;

// The wearer's pin, drawn as inline SVG in a divIcon. Leaflet's default marker
// is a PNG resolved relative to the stylesheet, which bundlers rewrite and
// routinely 404 -- the same reasoning that made the belongings a symbol rather
// than an image file before. This cannot 404 because there is no file.
const personIcon = L.divIcon({
  className: '',
  iconSize: [26, 34],
  iconAnchor: [13, 34],
  tooltipAnchor: [0, -30],
  html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 1C6.9 1 2 5.9 2 12c0 7.7 9.5 19.4 10.2 20.3a1 1 0 0 0 1.6 0C14.5 31.4 24 19.7 24 12 24 5.9 19.1 1 13 1z"
          fill="#0F766E" stroke="#FFFFFF" stroke-width="2"/>
    <circle cx="13" cy="12" r="4.2" fill="#FFFFFF"/>
  </svg>`
});

/**
 * Keep the view on the wearer as fresh fixes arrive.
 *
 * MapContainer reads `center` once and ignores later changes, so without this
 * the caregiver page's 30-second refresh would move the marker and leave the
 * viewport behind -- the person walks off the edge of their own map.
 */
function RecenterOnMove({ lat, lng }) {
  const map = useMap();
  useEffect(() => { map.setView([lat, lng], map.getZoom()); }, [map, lat, lng]);
  return null;
}

/**
 * The wearer's position, and where each of their belongings was last seen.
 *
 * `items` is what FE 10-4 asks for: a marker per belonging at the GPS fix that
 * was current when it was last sighted. The fixes were always being written --
 * every object event carries one -- and nothing had ever drawn them.
 *
 * Belongings are drawn as small amber circles rather than pins, so the one pin
 * on the map is still the person. A belonging usually sits exactly where the
 * wearer is standing, which would otherwise be two identical pins on one point.
 */
const LocationMap = ({ lat, lng, timestamp, items = [] }) => {
  // Tiles can be refused while every LOCUS request succeeds -- the tile host is
  // a different server with its own rules, and OpenStreetMap answers 403 to a
  // client it has decided to block. That failure is otherwise completely
  // silent: the console stays clean, the API returns 200s, and the map is just
  // empty. A system should be able to explain its own silence, so it says this
  // out loud and names the setting that fixes it.
  const [tilesRefused, setTilesRefused] = useState(false);
  // The wearer's own fix gets the check the item pins below already get. A
  // center of {undefined, undefined} leaves Leaflet with nothing to lay the
  // tiles out around, which reads as "the map is broken" rather than "no
  // position was recorded" -- the slowest possible way to find a missing fix.
  const centerLat = Number(lat);
  const centerLng = Number(lng);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
    return <div>No usable GPS fix to centre the map on.</div>;
  }

  const center = [centerLat, centerLng];
  // A sighting with no usable fix cannot be pinned. Checked here as well as on
  // the server: a marker at {undefined, undefined} throws inside Leaflet and
  // takes the whole map down with it, person included.
  const pinned = (items || []).filter(it =>
    Number.isFinite(Number(it?.location?.lat)) && Number.isFinite(Number(it?.location?.lng)));

  return (
    <div style={{ width: '100%' }}>
      <MapContainer
        center={center}
        zoom={15}
        minZoom={TILE_MIN_ZOOM}
        maxZoom={TILE_MAX_ZOOM}
        style={mapContainerStyle}
      >
        <TileLayer
          url={TILE_URL}
          attribution={TILE_ATTRIBUTION}
          maxZoom={TILE_MAX_ZOOM}
          minZoom={TILE_MIN_ZOOM}
          detectRetina={false}
          eventHandlers={{
            tileerror: () => setTilesRefused(true),
            tileload: () => setTilesRefused(false),
          }}
        />
        <RecenterOnMove lat={centerLat} lng={centerLng} />

        <Marker position={center} icon={personIcon}>
          <Tooltip>
            {timestamp ? `Last updated: ${formatClockTime(timestamp)}` : 'Current Location'}
          </Tooltip>
        </Marker>

        {pinned.map(it => (
          <CircleMarker
            key={it.item_id}
            center={[Number(it.location.lat), Number(it.location.lng)]}
            radius={7}
            pathOptions={{
              fillColor: '#F59E0B',
              fillOpacity: 0.95,
              color: '#FFFFFF',
              weight: 2,
            }}
          >
            <Tooltip>{`${it.name} — last seen ${formatClockTime(it.at)}`}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>

      {/* Out to Google Maps, in a new tab.
          The embedded map above answers "roughly where" on a 300px backdrop
          that is sometimes refused outright by the tile host. Google Maps
          answers "exactly where" -- street names, a building, satellite, and
          directions from wherever the caregiver is standing -- and it needs no
          API key, no billing account and no allowed-referrer list, because it
          is a plain link rather than an embedded SDK. The same maps/search URL
          the phone has always used, and the same one the belongings rows below
          this map already use; the wearer was the one thing on the page
          without it. */}
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${centerLat},${centerLng}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          marginTop: 12, padding: '10px 16px',
          background: 'var(--primary-dark, #0F766E)', color: '#FFFFFF',
          borderRadius: 'var(--radius-md, 12px)',
          fontSize: '0.9rem', fontWeight: 600, textDecoration: 'none',
        }}
      >
        {/* Inline, for the reason the pin above is inline: no file to 404. */}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
        </svg>
        See location in Google Maps
      </a>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-muted, #667)' }}>
        Opens in a new tab, at {centerLat.toFixed(5)}, {centerLng.toFixed(5)}
        {timestamp ? ` · fix taken ${formatClockTime(timestamp)}` : ''}.
      </p>

      {tilesRefused && !MAPTILER_KEY && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted, #667)' }}>
          Map tiles were refused by OpenStreetMap, whose servers are donated and
          decline clients they consider heavy use. The wearer&rsquo;s position
          above is correct; only the backdrop is missing. Set
          {' '}<code>VITE_MAPTILER_KEY</code> in{' '}
          <code>web_app/frontend/.env</code> and restart to use a tile host that
          serves this project properly.
        </p>
      )}
    </div>
  );
};

export default LocationMap;
