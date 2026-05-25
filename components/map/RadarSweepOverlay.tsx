"use client";

import { useEffect } from "react";

export default function RadarSweepOverlay({ onComplete }: { onComplete: () => void }) {
    useEffect(() => {
        const t = setTimeout(onComplete, 3000); // 2500ms sweep + 500ms fade
        return () => clearTimeout(t);
    }, [onComplete]);

    return (
        <div
            className="absolute inset-0 pointer-events-none z-10"
            style={{ animation: "radar-fade-out 0.5s ease-out 2.5s forwards" }}
        >
            <svg viewBox="0 0 100 100" className="w-full h-full">
                <defs>
                    <radialGradient id="sweepTrail" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor="#00ff88" stopOpacity="0" />
                        <stop offset="100%" stopColor="#00ff88" stopOpacity="0.2" />
                    </radialGradient>
                </defs>

                {/* Static concentric range rings */}
                <circle cx="50" cy="50" r="18" fill="none" stroke="#00ff88" strokeWidth="0.2" opacity="0.35" />
                <circle cx="50" cy="50" r="36" fill="none" stroke="#00ff88" strokeWidth="0.2" opacity="0.35" />

                {/* Rotating sweep group */}
                <g style={{ transformOrigin: "50px 50px", animation: "radar-sweep 2.5s linear 1 forwards" }}>
                    {/*
                      Trail wedge: ~60° arc counterclockwise from the leading edge (straight up).
                      Leading edge: (50, 0) — top of the viewBox.
                      60° CCW endpoint: (50 + 50*sin(-60°), 50 - 50*cos(-60°)) = (6.7, 25)
                    */}
                    <path
                        d="M 50 50 L 50 0 A 50 50 0 0 0 6.7 25 Z"
                        fill="url(#sweepTrail)"
                    />
                    {/* Sharp leading edge line */}
                    <line x1="50" y1="50" x2="50" y2="0" stroke="#00ff88" strokeWidth="0.8" opacity="0.95" />
                </g>

                {/* Center dot */}
                <circle cx="50" cy="50" r="1.2" fill="#00ff88" opacity="0.7" />
            </svg>
        </div>
    );
}
