import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  StyleSheet,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";

import { PressableScale } from "@/components/pressable-scale";
import { API_BASE_URL } from "@/constants/api";
import { Spacing } from "@/constants/theme";
import { useAuth } from "@/context/auth";
import { useTheme } from "@/hooks/use-theme";
import { reportError } from "@/lib/report-error";

// Diameter of the circular crop viewport - capped well under screen width
// so it always fits with room for the cancel/confirm buttons below it.
const CROP_SIZE = Math.min(Dimensions.get("window").width * 0.75, 300);
// The stored/uploaded square, independent of CROP_SIZE (a screen-density
// concern) - big enough to look sharp as a larger avatar somewhere later,
// small enough to keep the data URI well under profile-picture+api.ts's own
// MAX_AVATAR_LENGTH backstop.
const OUTPUT_SIZE = 480;
const MIN_SCALE = 1;
const MAX_SCALE = 4;

function clampOffset(value: number, limit: number) {
  "worklet";
  return Math.min(limit, Math.max(-limit, value));
}

// Circular, no-camera-roll-placeholder-vs-photo distinction - just a plain
// person icon when there's nothing to show yet, same shape as the real
// photo so the settings row's layout doesn't shift once one is set.
export function AvatarThumbnail({
  uri,
  size = 32,
}: {
  uri: string | null;
  size?: number;
}) {
  const theme = useTheme();
  if (!uri) {
    return (
      <View
        style={[
          styles.placeholder,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.backgroundElement,
          },
        ]}
      >
        <Ionicons
          name="person"
          size={size * 0.55}
          color={theme.textSecondary}
        />
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}

type PickedImage = { uri: string; width: number; height: number };

// Pinch to zoom, drag to reposition, both clamped every frame so the image
// can never shrink smaller than the circle or leave a gap at its edge -
// same "cover" idea as CSS's resizeMode:cover, just computed by hand since
// the crop math below needs the exact same numbers back out again.
function CropView({
  image,
  saving,
  onCancel,
  onConfirm,
}: {
  image: PickedImage;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (rect: { originX: number; originY: number; size: number }) => void;
}) {
  const theme = useTheme();
  const baseScale = Math.max(
    CROP_SIZE / image.width,
    CROP_SIZE / image.height,
  );
  const baseWidth = image.width * baseScale;
  const baseHeight = image.height * baseScale;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      const w = baseWidth * scale.value;
      const h = baseHeight * scale.value;
      translateX.value = clampOffset(
        savedTranslateX.value + e.translationX,
        Math.max(0, (w - CROP_SIZE) / 2),
      );
      translateY.value = clampOffset(
        savedTranslateY.value + e.translationY,
        Math.max(0, (h - CROP_SIZE) / 2),
      );
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, savedScale.value * e.scale),
      );
      scale.value = nextScale;
      // Re-clamp translation immediately - zooming out at a panned-off-center
      // position would otherwise open up a gap at the circle's edge before
      // the next pan gesture ever gets a chance to re-clamp it.
      const w = baseWidth * nextScale;
      const h = baseHeight * nextScale;
      translateX.value = clampOffset(translateX.value, Math.max(0, (w - CROP_SIZE) / 2));
      translateY.value = clampOffset(translateY.value, Math.max(0, (h - CROP_SIZE) / 2));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const gesture = Gesture.Simultaneous(pan, pinch);

  // Width/height/left/top computed directly (not via a transform:scale/
  // translate pair) specifically so confirm() below can read the exact same
  // formula back out to compute the crop rect - a transform's composition
  // order is one more thing that'd have to match perfectly between the live
  // preview and the final crop math, for no benefit here.
  const imageStyle = useAnimatedStyle(() => {
    const w = baseWidth * scale.value;
    const h = baseHeight * scale.value;
    return {
      width: w,
      height: h,
      left: (CROP_SIZE - w) / 2 + translateX.value,
      top: (CROP_SIZE - h) / 2 + translateY.value,
    };
  });

  const confirm = () => {
    const w = baseWidth * scale.value;
    const h = baseHeight * scale.value;
    const left = (CROP_SIZE - w) / 2 + translateX.value;
    const top = (CROP_SIZE - h) / 2 + translateY.value;
    const totalScale = w / image.width;
    const size = CROP_SIZE / totalScale;
    const originX = Math.min(Math.max(-left / totalScale, 0), image.width - size);
    const originY = Math.min(Math.max(-top / totalScale, 0), image.height - size);
    onConfirm({ originX, originY, size });
  };

  return (
    <View style={styles.cropWrap}>
      <GestureDetector gesture={gesture}>
        {/* Not overflow:hidden, unlike the old circular viewport - this is
            now just the CROP_SIZE hit-testing box the pan/pinch gesture is
            attached to. The image itself is free to render past its edges
            (see the dimmed layer below), which is exactly the point: you
            should be able to see the whole photo, not just what's already
            inside the circle. */}
        <View style={styles.cropGestureArea}>
          {/* Full photo, dimmed - same transform as the clear circular copy
              below so the two stay pixel-aligned as it's panned/zoomed,
              giving a preview of what's *outside* the crop instead of just
              clipping it away unseen. */}
          <Animated.Image
            source={{ uri: image.uri }}
            style={[styles.cropImage, imageStyle, styles.cropImageDimmed]}
          />
          {/* Same photo again, full brightness, clipped to the actual crop
              circle - this is the only layer that determines what gets
              saved (see confirm() above), the dimmed layer is purely a
              visual aid. */}
          <View
            style={[styles.cropCircleClip, { backgroundColor: theme.backgroundElement }]}
          >
            <Animated.Image
              source={{ uri: image.uri }}
              style={[styles.cropImage, imageStyle]}
            />
          </View>
        </View>
      </GestureDetector>

      <View style={styles.cropActions}>
        <PressableScale
          style={[styles.cropButton, { backgroundColor: theme.backgroundElement }]}
          onPress={onCancel}
          disabled={saving}
        >
          <Ionicons name="close" size={22} color={theme.text} />
        </PressableScale>
        <PressableScale
          style={[styles.cropButton, { backgroundColor: theme.backgroundElement }]}
          onPress={confirm}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <Ionicons name="checkmark" size={22} color={theme.text} />
          )}
        </PressableScale>
      </View>
    </View>
  );
}

// Full-screen, near-opaque backdrop (not the usual tap-outside-to-dismiss
// card) - accidentally losing a half-positioned crop to a stray backdrop
// tap would be a worse experience than requiring the explicit X button.
// Opens straight into the photo library (no camera option, matching
// app.json's own cameraPermission:false plugin config) - "edit" reuses this
// same flow rather than re-opening a saved crop, since only the final
// square image is stored, not the original photo + crop position.
export function ProfilePictureModal({
  onDismiss,
  onSaved,
}: {
  onDismiss: () => void;
  onSaved: (avatar: string) => void;
}) {
  const { token } = useAuth();
  const [image, setImage] = useState<PickedImage | null>(null);
  const [saving, setSaving] = useState(false);
  const launchedRef = useRef(false);

  useEffect(() => {
    if (launchedRef.current) return;
    launchedRef.current = true;
    (async () => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "photo access needed",
          "allow photo library access in settings to set a profile picture.",
        );
        onDismiss();
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 1,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) {
        onDismiss();
        return;
      }
      setImage({ uri: asset.uri, width: asset.width, height: asset.height });
    })().catch((error) => {
      reportError("[profile-picture] picker failed", error);
      onDismiss();
    });
  }, [onDismiss]);

  const handleConfirm = async (rect: {
    originX: number;
    originY: number;
    size: number;
  }) => {
    if (!image || !token) return;
    setSaving(true);
    try {
      const rendered = await ImageManipulator.manipulate(image.uri)
        .crop({
          originX: Math.round(rect.originX),
          originY: Math.round(rect.originY),
          width: Math.round(rect.size),
          height: Math.round(rect.size),
        })
        .resize({ width: OUTPUT_SIZE, height: OUTPUT_SIZE })
        .renderAsync();
      const result = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.85,
        base64: true,
      });
      if (!result.base64) throw new Error("no base64 output from manipulator");
      const avatar = `data:image/jpeg;base64,${result.base64}`;
      const res = await fetch(`${API_BASE_URL}/api/profile-picture`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ avatar }),
      });
      if (!res.ok) throw new Error(`server rejected avatar, status ${res.status}`);
      onSaved(avatar);
    } catch (error) {
      reportError("[profile-picture] save failed", error);
      Alert.alert("something went wrong", "please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.backdrop}>
      {image ? (
        <CropView
          image={image}
          saving={saving}
          onCancel={onDismiss}
          onConfirm={handleConfirm}
        />
      ) : (
        <ActivityIndicator color="#fff" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  cropWrap: {
    alignItems: "center",
    gap: Spacing.five,
  },
  // Sized to match the crop circle for gesture hit-testing, but no
  // overflow:hidden/border here anymore - see CropView's own comment for
  // why (the dimmed full-photo layer needs to render past these bounds).
  cropGestureArea: {
    width: CROP_SIZE,
    height: CROP_SIZE,
  },
  cropImage: {
    position: "absolute",
  },
  // Dims the full photo down to a faint silhouette rather than hiding it
  // outright - low enough opacity that it reads as "excluded" against the
  // backdrop without competing with the actual crop circle's full-brightness
  // copy on top of it.
  cropImageDimmed: {
    opacity: 0.25,
  },
  // The only clipped layer - same position/size as the old cropViewport,
  // holds the full-brightness copy of the photo that's actually saved.
  cropCircleClip: {
    position: "absolute",
    top: 0,
    left: 0,
    width: CROP_SIZE,
    height: CROP_SIZE,
    borderRadius: CROP_SIZE / 2,
    overflow: "hidden",
  },
  cropActions: {
    flexDirection: "row",
    gap: Spacing.five,
  },
  cropButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
});
