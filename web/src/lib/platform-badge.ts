const PLATFORM_BADGE_LIGHT: Record<string, { backgroundColor: string; color: string }> = {
  slack: { backgroundColor: "rgba(74, 21, 75, 0.12)", color: "#4A154B" },
  teams: { backgroundColor: "rgba(98, 100, 167, 0.12)", color: "#6264A7" },
  discord: { backgroundColor: "rgba(88, 101, 242, 0.12)", color: "#5865F2" },
  telegram: { backgroundColor: "rgba(40, 167, 230, 0.12)", color: "#229ED9" },
  "telegram-user": { backgroundColor: "rgba(40, 167, 230, 0.12)", color: "#229ED9" },
  mattermost: { backgroundColor: "rgba(34, 133, 213, 0.12)", color: "#2285D5" },
};

const PLATFORM_BADGE_DARK: Record<string, { backgroundColor: string; color: string }> = {
  slack: { backgroundColor: "rgba(241, 198, 243, 0.16)", color: "#F1C6F3" },
  teams: { backgroundColor: "rgba(188, 192, 255, 0.16)", color: "#BCC0FF" },
  discord: { backgroundColor: "rgba(180, 188, 255, 0.16)", color: "#B4BCFF" },
  telegram: { backgroundColor: "rgba(122, 213, 255, 0.16)", color: "#7AD5FF" },
  "telegram-user": { backgroundColor: "rgba(122, 213, 255, 0.16)", color: "#7AD5FF" },
  mattermost: { backgroundColor: "rgba(100, 180, 255, 0.16)", color: "#64B4FF" },
};

const FALLBACK_LIGHT = { backgroundColor: "rgba(124, 144, 130, 0.12)", color: "#7C9082" };
const FALLBACK_DARK = { backgroundColor: "rgba(187, 211, 193, 0.16)", color: "#BBD3C1" };

export function getPlatformBadgeStyle(platform: string, isDark: boolean) {
  const colors = isDark ? PLATFORM_BADGE_DARK[platform] : PLATFORM_BADGE_LIGHT[platform];
  if (colors) return colors;
  return isDark ? FALLBACK_DARK : FALLBACK_LIGHT;
}
