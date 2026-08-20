import React from 'react';
import { GoogleMap, Marker, useLoadScript } from '@react-google-maps/api';

const mapContainerStyle = {
  width: '100%',
  height: '300px',
  borderRadius: '8px'
};

const LocationMap = ({ lat, lng, timestamp }) => {
  const { isLoaded, loadError } = useLoadScript({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  });

  if (loadError) return <div>Error loading maps</div>;
  if (!isLoaded) return <div>Loading Map...</div>;

  const center = { lat, lng };

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
          title={timestamp ? `Last updated: ${new Date(timestamp).toLocaleTimeString()}` : "Current Location"} 
        />
      </GoogleMap>
    </div>
  );
};

export default LocationMap;
