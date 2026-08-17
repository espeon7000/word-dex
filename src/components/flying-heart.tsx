import { Ionicons } from "@expo/vector-icons";
import { useEffect } from "react";
import { Dimensions } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { useTheme } from "@/hooks/use-theme";

const HEART_POP_IN_DURATION_MS = 450;
const HEART_JIGGLE_DURATION_MS = 180;
const HEART_FLIGHT_DURATION_MS = 650;
const HEART_SIZE = 28;

// A random point on the screen's own perimeter, picked by walking a random
// distance around it (uniform over the edge, not just "pick a random side
// then a random point" which would over-favor short edges relative to long
// ones) - the "sent off to some random place on the border" part of the
// mail/bird-flying-away feel.
function randomEdgePoint(): { x: number; y: number } {
  const { width, height } = Dimensions.get("window");
  const perimeter = 2 * (width + height);
  const d = Math.random() * perimeter;
  if (d < width) return { x: d, y: 0 };
  if (d < width + height) return { x: width, y: d - width };
  if (d < 2 * width + height) {
    return { x: width - (d - width - height), y: height };
  }
  return { x: 0, y: height - (d - 2 * width - height) };
}

// One mounted instance per reaction (its own shared values), so two fast
// double-taps animate independently instead of a second tap's heart
// snapping/interrupting the first one's still-in-flight animation. `x`/`y`
// are the tap point in screen coordinates (event.absoluteX/absoluteY) -
// the parent overlay rendering this must itself sit at the true screen
// origin (not inset by any safe-area padding) for these to land where the
// finger actually was.
//
// Three beats, chained on the same shared values rather than as separate
// effects, so they play back to back with no gap: pop in from nothing,
// jiggle, then fly off and fade. rotate.value carries both the jiggle
// wobble *and* the flight's own spin - they're sequenced on the same value
// instead of two separate ones since a heart can only have one rotation at
// a time anyway.
export function FlyingHeart({
  x,
  y,
  onDone,
}: {
  x: number;
  y: number;
  onDone: () => void;
}) {
  const theme = useTheme();
  const scale = useSharedValue(0);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const rotate = useSharedValue(0);
  const opacity = useSharedValue(1);

  useEffect(() => {
    const target = randomEdgePoint();
    const dx = target.x - x;
    const dy = target.y - y;
    const spin = (Math.random() - 0.5) * 50;

    const flightDelay = HEART_POP_IN_DURATION_MS + HEART_JIGGLE_DURATION_MS;

    // Form from nothing, with a slight overshoot before settling at full
    // size - the jiggle (below) picks up immediately after.
    scale.value = withSequence(
      withTiming(1.3, { duration: HEART_POP_IN_DURATION_MS * 0.6 }),
      withTiming(1, { duration: HEART_POP_IN_DURATION_MS * 0.4 }),
    );

    rotate.value = withDelay(
      HEART_POP_IN_DURATION_MS,
      withSequence(
        // The jiggle - a quick back-and-forth wobble that settles back to
        // 0 right as flight begins.
        withTiming(14, { duration: HEART_JIGGLE_DURATION_MS * 0.22 }),
        withTiming(-14, { duration: HEART_JIGGLE_DURATION_MS * 0.22 }),
        withTiming(10, { duration: HEART_JIGGLE_DURATION_MS * 0.19 }),
        withTiming(-10, { duration: HEART_JIGGLE_DURATION_MS * 0.19 }),
        withTiming(0, { duration: HEART_JIGGLE_DURATION_MS * 0.18 }),
        // Flight's own spin, continuing straight on from the jiggle.
        withTiming(spin, { duration: HEART_FLIGHT_DURATION_MS }),
      ),
    );
    translateX.value = withDelay(
      flightDelay,
      withTiming(dx, {
        duration: HEART_FLIGHT_DURATION_MS,
        easing: Easing.out(Easing.quad),
      }),
    );
    translateY.value = withDelay(
      flightDelay,
      withTiming(dy, {
        duration: HEART_FLIGHT_DURATION_MS,
        easing: Easing.out(Easing.quad),
      }),
    );
    opacity.value = withDelay(
      flightDelay,
      withTiming(
        0,
        {
          duration: HEART_FLIGHT_DURATION_MS,
          easing: Easing.in(Easing.quad),
        },
        (finished) => {
          if (finished) runOnJS(onDone)();
        },
      ),
    );
  }, [x, y]);

  const style = useAnimatedStyle(() => ({
    position: "absolute" as const,
    left: x - HEART_SIZE / 2,
    top: y - HEART_SIZE / 2,
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
      { scale: scale.value },
    ],
  }));

  return (
    <Animated.View style={style} pointerEvents="none">
      {/* Two-tone heart: a filled, theme-colored heart underneath with a
          same-size white outline glyph laid directly on top of it, since
          Ionicons doesn't ship a single two-tone heart glyph. theme.text is
          lightness 5% (near-black regardless of hue) so it isn't usable
          here - textSecondary is the same hue at full saturation but
          actually reads as a color. */}
      <Ionicons name="heart" size={HEART_SIZE} color={theme.textSecondary} />
      <Ionicons
        name="heart-outline"
        size={HEART_SIZE}
        color="#fff"
        style={{ position: "absolute", top: 0, left: 0 }}
      />
    </Animated.View>
  );
}
