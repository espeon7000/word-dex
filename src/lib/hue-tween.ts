// Straight-line tween for a (hue, saturation) pair, through the wheel's own
// Cartesian space (see components/color-wheel.tsx's polarToCartesian/
// updateFromOffset - hue is the angle, saturation/100 is the radius
// fraction). Converts both endpoints to (x, y), lerps that directly, then
// converts each intermediate point back - so two points on the circumference
// a small angle apart cut a short chord that barely dips inward, while two
// points on opposite sides of the wheel (eg. 6 o'clock and 12 o'clock) pass
// straight through the center, exactly like actually drawing a straight line
// between them on the wheel would. Deliberately not a circular hue-angle
// interpolation (which would slide around the rim instead, stuck at
// whatever radius saturation happens to lerp to independently).
function toCartesian(hue: number, saturation: number): { x: number; y: number } {
  const rad = (hue * Math.PI) / 180;
  const r = saturation / 100;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}

function fromCartesian(x: number, y: number): { hue: number; saturation: number } {
  const angleDeg = (Math.atan2(y, x) * 180) / Math.PI;
  const hue = ((angleDeg % 360) + 360) % 360;
  const saturation = Math.min(100, Math.sqrt(x * x + y * y) * 100);
  return { hue, saturation };
}

// Drives onFrame with interpolated (hue, saturation) values roughly once per
// display frame for durationMs, resolving once it reaches the target
// exactly. Plain requestAnimationFrame + Date.now(), not Reanimated - the
// palette this ends up feeding (context/theme.tsx's own hue/saturation
// state) is read as plain color strings all over the app (every screen's
// `{ backgroundColor: theme.background }`), not through Animated.View/shared
// values, so driving the source state itself on the JS thread is what
// actually reaches all of those consumers without rewriting every screen to
// use Reanimated for its background color.
export function animateHueSaturation(
  from: { hue: number; saturation: number },
  to: { hue: number; saturation: number },
  durationMs: number,
  onFrame: (hue: number, saturation: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const p0 = toCartesian(from.hue, from.saturation);
    const p1 = toCartesian(to.hue, to.saturation);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const step = () => {
      const elapsed = Date.now() - start;
      const t = Math.min(1, elapsed / durationMs);
      const { hue, saturation } = fromCartesian(p0.x + dx * t, p0.y + dy * t);
      onFrame(hue, saturation);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
