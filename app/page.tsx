"use client";

import { useEffect } from "react";
import WorldMap from "@/components/map//WorldMap";
import VehicleSidebar from "@/components/sidebar/VehicleSidebar";
import { useVehicleStore } from "@/stores/vehicleStore";
import { mockVehicles, moveVehicle, } from "@/services/telemetrySimulator";

export default function HomePage() {
  const vehicles = useVehicleStore((state) => state.vehicles);
  const setVehicles = useVehicleStore((state) => state.setVehicles);

  useEffect(() => {
    setVehicles(mockVehicles);
  }, [setVehicles]);

  useEffect(() => {
    const interval = setInterval(() => {
      const updated = vehicles.map(moveVehicle);
      setVehicles(updated);
    }, 2000);

    return () => clearInterval(interval);
  }, [vehicles, setVehicles]);

  return (
    <main className="w-screen h-screen flex bg-black">
      <div className="flex-1">
        <WorldMap />
      </div>

      <div className="w-[360px] border-1 border-zinc-800 bg-zinc-950">
        <VehicleSidebar />
      </div>
    </main>
  );
}