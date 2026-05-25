import { renderToStaticMarkup } from "react-dom/server";
import type { Vehicle } from "@/types/vehicle";

type MarkerProps = Pick<Vehicle, "type" | "status" | "dataSource">;

function vehicleColor(type: Vehicle["type"], status: Vehicle["status"]): string {
    if (status === "stopped") return "#71717a";
    if (status === "delayed") return "#f59e0b";
    switch (type) {
        case "plane": return "#60a5fa";
        case "ship":  return "#22c55e";
        case "truck": return "#f59e0b";
    }
}

function MarkerSVG({ type, status, dataSource }: MarkerProps) {
    const color   = vehicleColor(type, status);
    const showRing = dataSource === "live" && status !== "stopped";

    return (
        <svg width="40" height="40" viewBox="0 0 40 40">
            {/* Background circle */}
            <circle
                cx="20" cy="20" r="18"
                fill="rgba(18,18,20,0.95)"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="0.75"
            />

            {/* Live glow ring — animated via CSS */}
            {showRing && (
                <circle
                    cx="20" cy="20" r="17"
                    fill="none"
                    stroke={color}
                    strokeWidth="1.5"
                    className="marker-glow-ring"
                />
            )}

            {/* Vehicle icon */}
            {type === "plane" && (
                <g transform="translate(20,20)">
                    <ellipse cx="0" cy="0" rx="1.3" ry="6.5" fill={color} />
                    <path d="M0 -3 L-8 3 L-6.5 3 L0 0.5 L6.5 3 L8 3 Z" fill={color} />
                    <path d="M0 5.5 L-3.5 8 L0 7 L3.5 8 Z" fill={color} />
                    <ellipse cx="0" cy="-7.5" rx="1.3" ry="2" fill={color} />
                </g>
            )}

            {type === "ship" && (
                <g transform="translate(20,20)">
                    <path
                        d="M-5 -8 Q-5 -9.5 0 -9.5 Q5 -9.5 5 -8 L6 7 Q6 8.5 0 9 Q-6 8.5 -6 7 Z"
                        fill={color}
                    />
                    <rect x="-3" y="-6" width="6" height="3.5" rx="0.5" fill={color} opacity="0.55" />
                    <rect x="-3.5" y="-0.5" width="7" height="3.5" rx="0.5" fill="none" stroke={color} strokeWidth="0.6" opacity="0.7" />
                </g>
            )}

            {type === "truck" && (
                <g transform="translate(20,20)">
                    <rect x="-9" y="-4.5" width="11" height="7" rx="1" fill={color} />
                    <path d="M2 -3 L6 -3 Q7 -3 7 -1 L7 2.5 L2 2.5 Z" fill={color} />
                    <circle cx="-6" cy="4.5" r="1.5" fill={color} opacity="0.85" />
                    <circle cx="0"  cy="4.5" r="1.5" fill={color} opacity="0.85" />
                    <circle cx="5"  cy="4.5" r="1.5" fill={color} opacity="0.85" />
                </g>
            )}
        </svg>
    );
}

export function getVehicleColor(vehicle: MarkerProps): string {
    return vehicleColor(vehicle.type, vehicle.status);
}

export function createVehicleMarkerElement(
    vehicle: MarkerProps,
    appearDelay?: number,
    vehicleColorOverride?: string,
): HTMLDivElement {
    const el = document.createElement("div");
    const needsRelative = appearDelay !== undefined;
    el.style.cssText = [
        "cursor:pointer",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "width:40px",
        "height:40px",
        "pointer-events:auto",
        ...(needsRelative ? ["position:relative"] : []),
    ].join(";");
    el.innerHTML = renderToStaticMarkup(<MarkerSVG {...vehicle} />);

    if (appearDelay !== undefined) {
        el.classList.add("marker-boot-enter");
        el.style.animationDelay = `${appearDelay}ms`;

        const ping = document.createElement("div");
        ping.className = "marker-boot-ping";
        ping.style.color = vehicleColorOverride ?? vehicleColor(vehicle.type, vehicle.status);
        ping.style.animationDelay = `${appearDelay}ms`;
        ping.addEventListener("animationend", () => ping.remove(), { once: true });
        el.appendChild(ping);
    }

    return el;
}
