import Svg, { Circle, Path } from "react-native-svg";
import { colors } from "../../constants/theme";

type Props = {
  size?: number;
  color?: string;
};

export function ClockIcon({ size = 14, color = colors.textMuted }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Circle cx={7} cy={7} r={6} stroke={color} strokeWidth={1.5} />
      <Path d="M7 4V7L9 9" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}
