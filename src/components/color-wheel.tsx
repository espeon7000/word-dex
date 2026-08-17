import { useCallback } from "react";
import { Image, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
} from "react-native-reanimated";

const INDICATOR_SIZE = 22;

// A pre-rendered, per-pixel HSV wheel (angle = hue, radius = saturation) -
// genuinely continuous, unlike drawing it as a ring of solid-color pie
// slices, which shows visible banding at any slice count fine enough to
// still be a small enough scene graph to render live.
const WHEEL_IMAGE = require("@/assets/images/color-wheel.png");

function polarToCartesian(radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
}

export default function ColorWheel({
  hue,
  saturation,
  onChange,
  size = 220,
}: {
  hue: number;
  saturation: number;
  onChange: (hue: number, saturation: number) => void;
  size?: number;
}) {
  const radius = size / 2;

  // Mirrors the wheel image's own layout (angle -> hue, radius fraction ->
  // saturation) so the indicator dot always lands exactly where the
  // corresponding color is drawn.
  const indicatorPosition = useCallback(
    (h: number, s: number) => {
      const dist = (Math.min(100, Math.max(0, s)) / 100) * radius;
      return polarToCartesian(dist, h);
    },
    [radius],
  );

  const translateX = useSharedValue(indicatorPosition(hue, saturation).x);
  const translateY = useSharedValue(indicatorPosition(hue, saturation).y);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value - INDICATOR_SIZE / 2 },
      { translateY: translateY.value - INDICATOR_SIZE / 2 },
    ],
  }));

  const updateFromOffset = useCallback(
    (dx: number, dy: number) => {
      const dist = Math.min(radius, Math.sqrt(dx * dx + dy * dy));
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const nextHue = ((angle % 360) + 360) % 360;
      const nextSaturation = (dist / radius) * 100;
      onChange(nextHue, nextSaturation);
    },
    [radius, onChange],
  );

  const handleTouch = useCallback(
    (x: number, y: number) => {
      const dx = x - radius;
      const dy = y - radius;
      const dist = Math.min(radius, Math.sqrt(dx * dx + dy * dy));
      const angle = Math.atan2(dy, dx);
      translateX.value = dist * Math.cos(angle);
      translateY.value = dist * Math.sin(angle);
      updateFromOffset(dx, dy);
    },
    [radius, updateFromOffset, translateX, translateY],
  );

  const gesture = Gesture.Pan()
    .onBegin((e) => runOnJS(handleTouch)(e.x, e.y))
    .onUpdate((e) => runOnJS(handleTouch)(e.x, e.y));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width: size, height: size }}>
        <Image
          source={WHEEL_IMAGE}
          style={{ width: size, height: size }}
          resizeMode="contain"
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            { left: radius, top: radius },
            indicatorStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  indicator: {
    position: "absolute",
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    borderRadius: INDICATOR_SIZE / 2,
    borderWidth: 3,
    borderColor: "#FFFFFF",
    backgroundColor: "transparent",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
});
