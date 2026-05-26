import { renderToStaticMarkup } from "react-dom/server";
import type { Vehicle } from "@/types/vehicle";
import { vehicleHex } from "@/lib/vehicleColors";

type MarkerProps = Pick<Vehicle, "type" | "status" | "dataSource" | "company">;

// Color palette: see `lib/vehicleColors.ts` for the hex tokens. Two tiers per
// vehicle type — saturated Petros brand hue vs desaturated live variant.
// Status (stopped, delayed) overrides type at the marker layer.

function MarkerSVG({ type, status, company }: MarkerProps) {
    const isPetros = company === "Petros Transport";
    const color    = vehicleHex(type, status, isPetros);

    // Petros markers get a faint dark outline as a second differentiation
    // axis on top of saturated color. Reads as "this is yours" without
    // bringing back size or opacity gymnastics. Live markers stay stroke-less
    // so they remain visually quieter. paint-order ensures the dark stroke
    // renders behind the colored fill, so the outline reads as a halo
    // rather than cutting into the icon silhouette.
    const stroke      = isPetros ? "rgba(0,0,0,0.6)" : "none";
    const strokeWidth = isPetros ? 0.8 : 0;
    const paintOrder  = isPetros ? "stroke" : undefined;

    return (
        <svg width="40" height="40" viewBox="0 0 40 40">
            {type === "plane" && (
                <g transform="translate(20,20)" paintOrder={paintOrder}>
                    <ellipse cx="0" cy="0" rx="1.3" ry="6.5" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                    <path d="M0 -3 L-8 3 L-6.5 3 L0 0.5 L6.5 3 L8 3 Z" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                    <path d="M0 5.5 L-3.5 8 L0 7 L3.5 8 Z" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                    <ellipse cx="0" cy="-7.5" rx="1.3" ry="2" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                </g>
            )}

            {type === "ship" && (
                <g transform="translate(20,20)" paintOrder={paintOrder}>
                    {/* Slim container-ship silhouette — width trimmed from ±5
                        to ±2.5 so the length:width ratio matches a real cargo
                        vessel (~4:1) and feels proportional to the plane's
                        thin fuselage rather than bulky next to it. */}

                    {/* 1. Hull — narrow, with tapered bow at top */}
                    <path
                        d="M0 -11 L2.5 -5 L2.5 9 Q2.5 11 1 11 L-1 11 Q-2.5 11 -2.5 9 L-2.5 -5 Z"
                        fill={color}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                    />
                    {/* 2. Container stack — forward block */}
                    <rect x="-2" y="-2.5" width="4" height="2.5" rx="0.3" fill={color} opacity="0.5" />
                    {/* 3. Container stack — middle block */}
                    <rect x="-2" y="0.5" width="4" height="2" rx="0.3" fill={color} opacity="0.5" />
                    {/* 4. Bridge tower at the stern */}
                    <rect x="-1.5" y="3.5" width="3" height="3.5" rx="0.4" fill="rgba(0,0,0,0.5)" />
                    {/* 5. Bridge window accent */}
                    <rect x="-1" y="4.5" width="2" height="0.7" fill={color} opacity="0.9" />
                </g>
            )}

            {type === "truck" && (
                <g transform="translate(20,20)" paintOrder={paintOrder}>
                    {/* Slim bird's-eye semi-truck — width trimmed from ±5 to
                        ±3 so the silhouette has the same minimal weight as the
                        plane. Cab at the TOP so rotation to heading points
                        the cab in the direction of travel. */}

                    {/* 1. Cargo trailer — narrow rectangle at the back */}
                    <rect x="-3" y="-0.5" width="6" height="10" rx="0.4" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                    {/* 2. Cab — smaller rounded rectangle at the front */}
                    <rect x="-2.5" y="-7.5" width="5" height="6" rx="1" fill={color} stroke={stroke} strokeWidth={strokeWidth} />
                    {/* 3. Windshield — thin dark band on the front of the cab */}
                    <rect x="-2" y="-7" width="4" height="1" rx="0.2" fill="rgba(0,0,0,0.5)" />
                    {/* 4. Cab vent — small dark detail */}
                    <rect x="-0.7" y="-4.5" width="1.4" height="1.4" rx="0.2" fill="rgba(0,0,0,0.4)" />
                    {/* 5. Trailer rear doors — dark stripe at the back */}
                    <rect x="-2.5" y="8" width="5" height="1.2" fill="rgba(0,0,0,0.5)" />
                </g>
            )}
        </svg>
    );
}

export function getVehicleColor(vehicle: MarkerProps): string {
    return vehicleHex(vehicle.type, vehicle.status, vehicle.company === "Petros Transport");
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
        ping.style.color = vehicleColorOverride ?? vehicleHex(vehicle.type, vehicle.status, vehicle.company === "Petros Transport");
        ping.style.animationDelay = `${appearDelay}ms`;
        ping.addEventListener("animationend", () => ping.remove(), { once: true });
        el.appendChild(ping);
    }

    return el;
}
