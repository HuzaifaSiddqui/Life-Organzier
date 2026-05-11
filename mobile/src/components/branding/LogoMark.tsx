import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

type Props = {
  size?: number;
};

export function LogoMark({ size = 48 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 128 128" fill="none">
      <Path
        d="M85.3334 21.3333H42.6667C30.8846 21.3333 21.3334 30.8846 21.3334 42.6667V85.3333C21.3334 97.1154 30.8846 106.667 42.6667 106.667H85.3334C97.1155 106.667 106.667 97.1154 106.667 85.3333V42.6667C106.667 30.8846 97.1155 21.3333 85.3334 21.3333Z"
        fill="url(#paint0_linear_logo_mark)"
      />
      <Path
        d="M48 64L58.6667 74.6667L85.3333 48"
        stroke="white"
        strokeWidth={6.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M47.9999 89.6C50.3564 89.6 52.2666 87.6897 52.2666 85.3333C52.2666 82.9769 50.3564 81.0667 47.9999 81.0667C45.6435 81.0667 43.7333 82.9769 43.7333 85.3333C43.7333 87.6897 45.6435 89.6 47.9999 89.6Z"
        fill="#E5F4FF"
      />
      <Path
        d="M74.6667 94.9333C77.0231 94.9333 78.9334 93.0231 78.9334 90.6667C78.9334 88.3103 77.0231 86.4 74.6667 86.4C72.3103 86.4 70.4 88.3103 70.4 90.6667C70.4 93.0231 72.3103 94.9333 74.6667 94.9333Z"
        fill="#E5F4FF"
      />
      <Path
        d="M85.3333 84.2667C87.6897 84.2667 89.6 82.3564 89.6 80C89.6 77.6436 87.6897 75.7333 85.3333 75.7333C82.9769 75.7333 81.0667 77.6436 81.0667 80C81.0667 82.3564 82.9769 84.2667 85.3333 84.2667Z"
        fill="#E5F4FF"
      />
      <Path opacity={0.6} d="M48 85.3333L74.6667 90.6667" stroke="#E5F4FF" strokeWidth={2.13333} />
      <Path opacity={0.6} d="M74.6666 90.6667L85.3333 80" stroke="#E5F4FF" strokeWidth={2.13333} />
      <Defs>
        <LinearGradient
          id="paint0_linear_logo_mark"
          x1={21.3334}
          y1={21.3333}
          x2={106.667}
          y2={106.667}
          gradientUnits="userSpaceOnUse"
        >
          <Stop stopColor="#1D99FF" />
          <Stop offset={1} stopColor="#005BB5" />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}
