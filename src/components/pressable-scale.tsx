import type { StyleProp, ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

// How small a button shrinks to on press - uniform on all sides (a plain
// scale transform), reading as "pushed away from you." Shared by every
// PressableScale instance, so every button using it presses the same way.
const PRESS_SCALE = 0.94;

// Gesture.Tap (not Pressable) specifically so press-in/press-out drive a real
// tweened animation instead of Pressable's own instant pressed-state style
// swap.
export function PressableScale({
  onPress,
  style,
  children,
  disabled,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const scale = useSharedValue(1);

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onBegin(() => {
      scale.value = withTiming(PRESS_SCALE, { duration: 80 });
    })
    .onFinalize(() => {
      scale.value = withTiming(1, { duration: 150 });
    })
    .onEnd(() => {
      runOnJS(onPress)();
    });

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={tap}>
      <Animated.View style={[style, pressStyle]}>{children}</Animated.View>
    </GestureDetector>
  );
}
