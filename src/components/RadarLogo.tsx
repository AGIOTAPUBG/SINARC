interface RadarLogoProps {
  className?: string;
  size?: number;
}

export function RadarLogo({ className = '', size = 28 }: RadarLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" opacity="0.9" />
      <circle cx="16" cy="16" r="8.5" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <circle cx="16" cy="16" r="4" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
      <path
        d="M16 16L25.2 6.8"
        stroke="#16A34A"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
      <circle cx="23.5" cy="8.5" r="2" fill="#16A34A" />
    </svg>
  );
}
