import React from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix for Leaflet default icon issues in React
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
});
L.Marker.prototype.options.icon = DefaultIcon;

// Internal component to handle map centering and resizing
function ChangeView({ center, zoom }) {
    const map = useMap();
    
    React.useEffect(() => {
        map.setView(center, zoom);
        // CRITICAL: Leaflet needs to re-calculate its size if it was 
        // rendered while hidden or during a side-panel animation.
        setTimeout(() => {
            map.invalidateSize();
        }, 300);
    }, [center, zoom, map]);
    
    return null;
}

const MapRenderer = React.memo(({ block }) => {
    console.log("[MapRenderer] Rendering block:", block.label);
    const { lat, lng, zoom = 13, label } = block;
    
    // Stabilize position to prevent Leaflet jumps
    const position = React.useMemo(() => [
        typeof lat === 'number' ? lat : parseFloat(lat) || 0,
        typeof lng === 'number' ? lng : parseFloat(lng) || 0
    ], [lat, lng]);

    // Check for valid numbers
    if (isNaN(position[0]) || isNaN(position[1]) || (position[0] === 0 && position[1] === 0)) {
        return (
            <div className="p-4 bg-red-500/10 text-red-400 rounded-xl border border-red-500/20 text-xs italic">
                Waiting for valid coordinates... ({lat}, {lng})
            </div>
        );
    }

    return (
        <div className="w-full h-[400px] rounded-xl overflow-hidden border border-gray-300 relative group">
            <MapContainer 
                center={position} 
                zoom={zoom} 
                scrollWheelZoom={false}
                style={{ height: '100%', width: '100%', background: '#f3f4f6' }}
            >
                <ChangeView center={position} zoom={zoom} />
                
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                />
                
                <Marker position={position}>
                    <Popup>
                        <div className="text-black font-medium p-1">
                            {label || 'Target Location'}
                        </div>
                    </Popup>
                </Marker>
            </MapContainer>
            
            <div className="absolute top-4 right-4 z-[1000] bg-gray-200 backdrop-blur-md border border-gray-300 p-2 rounded-lg text-[10px] uppercase tracking-widest text-cyan-400 font-bold pointer-events-none">
                GRID_LOC: {position[0].toFixed(4)}, {position[1].toFixed(4)}
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // Only re-render if the block ID or location actually changes
    return prevProps.block.id === nextProps.block.id && 
           prevProps.block.lat === nextProps.block.lat && 
           prevProps.block.lng === nextProps.block.lng;
});

export default MapRenderer;
