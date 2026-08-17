import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { API_BASE_URL } from "@/constants/api";

// v1 is iOS-only - Android push needs a dev-client build to test at all
// (Expo Go dropped Android push support in SDK 53), a bigger step than this
// feature warrants yet. In-app reactions (the heart animation) work on both
// platforms regardless; only the push itself is gated here.
export async function registerForPushNotifications(
  authToken: string,
): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== "granted") {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== "granted") return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId,
    });

    await fetch(`${API_BASE_URL}/api/push-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token }),
    });
  } catch (error) {
    console.error("[push-notifications] registration failed", error);
  }
}

// Tapping a delivered push (foreground, background, or cold-launch-from-tap)
// fires this - the OS already opens/foregrounds the app on its own for any
// tap, so onTap is only for the extra "land on the explore tab" touch, not
// for opening the app itself.
export function attachNotificationTapListener(onTap: () => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(() => {
    onTap();
  });
  return () => sub.remove();
}
