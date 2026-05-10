import Svg, { Path } from "react-native-svg";

export function SendIcon({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <Path
        d="M18 2L9 11M18 2L12 18L9 11M18 2L2 8L9 11"
        stroke="white"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
