import { useWindowDimensions } from "react-native";
import { isWideWidth } from "../utils/layout";
import { spacing } from "./tokens";

/**
 * `isWide`: the desktop layout (sidebar, capped content, dialogs instead of sheets). Follows window resizes.
 * `bottomPad(phone)`: a scroll view's bottom padding — `phone` clears the floating bottom nav and "+" on the phone;
 * wide windows have neither, so a normal end gap.
 */
export function useLayout(): { isWide: boolean; width: number; bottomPad: (phone: number) => number } {
  const { width } = useWindowDimensions();
  const isWide = isWideWidth(width);
  return { isWide, width, bottomPad: (phone) => (isWide ? spacing.xxl : phone) };
}
