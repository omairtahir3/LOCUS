import React from 'react';
import { GoogleMap, Marker, useLoadScript } from '@react-google-maps/api';
import { formatClockTime } from '../utils/dateUtils';

const mapContainerStyle = {
  width: '100%',
  height: '300px',
  borderRadius: '8px'
};

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
  const { isLoaded, loadError } = useLoadScript({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  });

  if (loadError) return <div>Error loading maps</div>;
  if (!isLoaded) return <div>Loading Map...</div>;

  const center = { lat, lng };
  // A sighting with no usable fix cannot be pinned. Checked here as well as on
  // the server: a marker at {undefined, undefined} throws inside the maps SDK
  // and takes the whole map down with it, person included.
  const pinned = (items || []).filter(it =>
    Number.isFinite(Number(it?.location?.lat)) && Number.isFinite(Number(it?.location?.lng)));

  return (
    <div style={{ width: '100%' }}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        zoom={15}
        center={center}
        options={{ disableDefaultUI: true, zoomControl: true }}
      >
        <Marker
          position={center}
          title={timestamp ? `Last updated: ${formatClockTime(timestamp)}` : "Current Location"}
        />
        {pinned.map(it => (
          <Marker
            key={it.item_id}
            position={{ lat: Number(it.location.lat), lng: Number(it.location.lng) }}
            // A symbol, not an image file: it needs no asset and cannot 404.
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 7,
              fillColor: '#F59E0B',
              fillOpacity: 0.95,
              strokeColor: '#FFFFFF',
              strokeWeight: 2,
            }}
            title={`${it.name} — last seen ${formatClockTime(it.at)}`}
          />
        ))}
      </GoogleMap>
    </div>
  );
};

export default LocationMap;
