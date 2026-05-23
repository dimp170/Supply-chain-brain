"use client";

import { useVehicleStore } from "@/stores/vehicleStore";

export default function VehicleSidebar() {
  const vehicle = useVehicleStore((state) => state.selectedVehicle);

  if(!vehicle) {
    return (
      <div className="p-6 text-zinc-400">
        <h2 className="text-xl font-semibold mb-4">
            Logistics Control Tower
        </h2>

        <p>Please select a vehicle from the map.</p>
      </div>
    );
  }
  return (
    <div className="p-6 text-white space-y-6">
        <div>
            <h2 className="text-xl font-bold">
                {vehicle.name}
            </h2>

            <p className="text-zinc-400 capitalize">
                {vehicle.type}
            </p>
        </div>

        <div className="space-y-4">
            <div>
                <p className="text-zinc-500 text-sm">
                    Status
                </p>

                <p className="capitalize">
                    {vehicle.status}
                </p>
            </div>

            <div>
                <p className="text-zinc-500 text-sm">
                    Speed
                </p>

                <p>{vehicle.speed} km/h</p>
            </div>

            <div>
                <p className="text-zinc-500 text-sm">
                    ETA
                </p>

                <p>{vehicle.eta}</p>
            </div>

            <div>
                <p className="text-zinc-500 text-sm">
                    Cargo
                </p>

                <p>{vehicle.cargo}</p>
            </div>

            <div>
                <p className="text-zinc-500 text-sm">
                    Coordinates
                </p>
                <p>
                    {vehicle.latitude.toFixed(4)},
                    {" "}
                    {vehicle.longitude.toFixed(4)}
                </p>
            </div>

            {vehicle.temperature && (
                <div>
                    <p className="text-zinc-500 text-sm">
                        Temperature
                    </p>
                    <p>{vehicle.temperature} °C</p>
                </div>
            )}
        </div>
    </div>
  );
}