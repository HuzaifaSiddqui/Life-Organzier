import Svg, { Defs, LinearGradient, Path, Stop, Text as SvgText } from "react-native-svg";

type Props = {
  width?: number;
  height?: number;
};

export function LogoFull({ width = 200, height = 75 }: Props) {
  return (
    <Svg width={width} height={height} viewBox="0 0 320 120" fill="none">
      <Path
        d="M80 20H40C28.9543 20 20 28.9543 20 40V80C20 91.0457 28.9543 100 40 100H80C91.0457 100 100 91.0457 100 80V40C100 28.9543 91.0457 20 80 20Z"
        fill="url(#paint0_linear_logo_full)"
      />
      <Path
        d="M45 60L55 70L80 45"
        stroke="white"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M45 84C47.2091 84 49 82.2091 49 80C49 77.7909 47.2091 76 45 76C42.7909 76 41 77.7909 41 80C41 82.2091 42.7909 84 45 84Z"
        fill="#E5F4FF"
      />
      <Path
        d="M70 89C72.2091 89 74 87.2091 74 85C74 82.7909 72.2091 81 70 81C67.7909 81 66 82.7909 66 85C66 87.2091 67.7909 89 70 89Z"
        fill="#E5F4FF"
      />
      <Path
        d="M80 79C82.2091 79 84 77.2091 84 75C84 72.7909 82.2091 71 80 71C77.7909 71 76 72.7909 76 75C76 77.2091 77.7909 79 80 79Z"
        fill="#E5F4FF"
      />
      <Path opacity={0.6} d="M45 80L70 85" stroke="#E5F4FF" strokeWidth={2} />
      <Path opacity={0.6} d="M70 85L80 75" stroke="#E5F4FF" strokeWidth={2} />
      <SvgText
        x={120}
        y={50}
        fill="#1D99FF"
        fontSize={28}
        fontWeight="600"
        fontFamily="Inter"
      >
        Life Organizer
      </SvgText>
      <SvgText
        x={120}
        y={75}
        fill="#64748B"
        fontSize={14}
        fontWeight="400"
        fontFamily="Inter"
      >
        Smart Productivity Assistant
      </SvgText>
      <Defs>
        <LinearGradient
          id="paint0_linear_logo_full"
          x1={20}
          y1={20}
          x2={100}
          y2={100}
          gradientUnits="userSpaceOnUse"
        >
          <Stop stopColor="#1D99FF" />
          <Stop offset={1} stopColor="#005BB5" />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}
