export interface RoutePoint {
    lng: number;
    lat: number;
    speedLimit: number;
    trafficSpeed?: number;
    cumulativeDistance?: number; // Total distance travelled since the start of the route
    cumulativeTime?: number;     // Total time travelled since the start of the route
}