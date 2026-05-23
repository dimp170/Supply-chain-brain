"use client";

import { use, useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { useVehicleStore } from "@/stores/vehicleStore";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

export default function WorldMap() {
    const mapContainer = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const vehicles = useVehicleStore((state) => state.vehicles);
    const selectVehicle = useVehicleStore((state) => state.selectVehicle);
    useEffect(() => {
        if (!mapContainer.current) return;
        if (mapRef.current) return; // Initialize map only once
        mapRef.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: "mapbox://styles/mapbox/dark-v11",
            center: [0, 20],
            zoom: 1.5,
        });

        return () => {
            mapRef.current?.remove();
        };
    }, []);

    useEffect(() => {
        if (!mapRef.current) return;
        markersRef.current.forEach((marker) => marker.remove());
        markersRef.current = [];
        vehicles.forEach((vehicle) => {
            const el = document.createElement("div");
            el.className = "Vehicle-marker";
            el.style.width = "16px";
            el.style.height = "16px";
            el.style.borderRadius = "999px";
            el.style.cursor = "pointer";
            el.style.border = "2px solid white";
            el.style.boxShadow = "0 0 12px rgba(255,255,255,0.4)";
            if (vehicle.status === "moving") {
                el.style.backgroundColor = "#22c55e";
            }

            if (vehicle.status === "delayed") {
                el.style.backgroundColor = "#f59e0b";
            }

            if (vehicle.status === "stopped") {
                el.style.backgroundColor = "#ef4444";
            }

            el.onclick = () => {
                selectVehicle(vehicle);
            };
            
            const marker = new mapboxgl.Marker(el)
                .setLngLat([vehicle.longitude, vehicle.latitude])
                .addTo(mapRef.current!);
            markersRef.current.push(marker);
        });
    }, [vehicles]);

    return (<div ref={mapContainer} className="w-full h-full" />);
}