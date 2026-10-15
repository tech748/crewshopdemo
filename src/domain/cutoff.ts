/** Online bookings need at least `cutoffHours` between now and the ship's ETA. */
export function withinCutoffWindow(now: Date, eta: Date, cutoffHours: number): boolean {
  return eta.getTime() - now.getTime() >= cutoffHours * 3_600_000;
}
export function whatsappHandoffUrl(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
