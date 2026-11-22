import type { SVGProps } from "react";

interface AgentBrandIconProps extends SVGProps<SVGSVGElement> {
  id: string;
  size?: number;
}

export function AgentBrandIcon({ id, size = 28, ...rest }: AgentBrandIconProps) {
  switch (id) {
    case "antigravity":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          {...rest}
        >
          <mask
            id="cbu-ag-0"
            maskUnits="userSpaceOnUse"
            x="0"
            y="1"
            width="24"
            height="23"
          >
            <path
              d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
              fill="#fff"
            />
          </mask>
          <g mask="url(#cbu-ag-0)">
            <g filter="url(#cbu-ag-1)">
              <path
                d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z"
                fill="#FFE432"
              />
            </g>
            <g filter="url(#cbu-ag-2)">
              <path
                d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z"
                fill="#FC413D"
              />
            </g>
            <g filter="url(#cbu-ag-3)">
              <path
                d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z"
                fill="#00B95C"
              />
            </g>
            <g filter="url(#cbu-ag-4)">
              <path
                d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z"
                fill="#00B95C"
              />
            </g>
            <g filter="url(#cbu-ag-5)">
              <path
                d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z"
                fill="#3186FF"
              />
            </g>
            <g filter="url(#cbu-ag-6)">
              <path
                d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z"
                fill="#FBBC04"
              />
            </g>
            <g filter="url(#cbu-ag-7)">
              <path
                d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z"
                fill="#3186FF"
              />
            </g>
            <g filter="url(#cbu-ag-8)">
              <path
                d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z"
                fill="#749BFF"
              />
            </g>
            <g filter="url(#cbu-ag-9)">
              <path
                d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z"
                fill="#FC413D"
              />
            </g>
            <g filter="url(#cbu-ag-10)">
              <path
                d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z"
                fill="#FFEE48"
              />
            </g>
          </g>
          <defs>
            <filter id="cbu-ag-1" x="-3.288" y="-11.917" width="19.838" height="17.587" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="1.117" result="effect1" />
            </filter>
            <filter id="cbu-ag-2" x="4.251" y="-13.493" width="38.9" height="38.565" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="5.4" result="effect1" />
            </filter>
            <filter id="cbu-ag-3" x="-21.889" y="-10.592" width="40.955" height="36.517" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="4.591" result="effect1" />
            </filter>
            <filter id="cbu-ag-4" x="-19.099" y="-10.278" width="36.632" height="36.595" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="4.591" result="effect1" />
            </filter>
            <filter id="cbu-ag-5" x=".981" y="8.758" width="33.533" height="34.087" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="4.363" result="effect1" />
            </filter>
            <filter id="cbu-ag-6" x="-6.143" y="-21.659" width="35.978" height="35.276" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="3.954" result="effect1" />
            </filter>
            <filter id="cbu-ag-7" x="-11.96" y="-.46" width="45.114" height="46.523" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="3.531" result="effect1" />
            </filter>
            <filter id="cbu-ag-8" x="10.485" y=".58" width="25.094" height="24.054" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="3.159" result="effect1" />
            </filter>
            <filter id="cbu-ag-9" x="5.833" y="-12.467" width="33.508" height="30.007" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="2.669" result="effect1" />
            </filter>
            <filter id="cbu-ag-10" x="-8.355" y="-8.876" width="22.194" height="26.151" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="3.303" result="effect1" />
            </filter>
          </defs>
        </svg>
      );

    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
            fill="#D97757"
          />
        </svg>
      );

    case "codex":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
          <path
            d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
            fill="url(#cbu-codex-grad)"
          />
          <defs>
            <linearGradient id="cbu-codex-grad" x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
              <stop stopColor="#B1A7FF" />
              <stop offset=".5" stopColor="#7A9DFF" />
              <stop offset="1" stopColor="#3941FF" />
            </linearGradient>
          </defs>
        </svg>
      );

    case "cursor":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...rest}>
          <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
        </svg>
      );

    case "windsurf":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
          <path
            d="M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z"
            fill="#09B6A2"
          />
        </svg>
      );

    case "copilot":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
          <path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
        </svg>
      );

    case "commandcode":
      return (
        <svg width={size} height={size} viewBox="40 40 143.5 143.6" fill="none" aria-hidden="true" {...rest}>
          <path
            d="M40 110C40 77.0017 40 60.5025 50.2513 50.2513C60.5025 40 77.0017 40 110 40H113.5C146.498 40 162.997 40 173.249 50.2513C183.5 60.5025 183.5 77.0017 183.5 110V113.6C183.5 146.598 183.5 163.097 173.249 173.349C162.997 183.6 146.498 183.6 113.5 183.6H110C77.0017 183.6 60.5025 183.6 50.2513 173.349C40 163.097 40 146.598 40 113.6V110Z"
            fill="currentColor"
          />
          <path
            d="M138.806 67.6172C129.33 67.6172 121.622 75.3252 121.622 84.8007V92.165H101.984V84.8007C101.984 75.3252 94.2761 67.6172 84.8006 67.6172C75.3252 67.6172 67.6172 75.3252 67.6172 84.8007C67.6172 94.2761 75.3252 101.984 84.8006 101.984H92.165V121.622H84.8006C75.3252 121.622 67.6172 129.33 67.6172 138.806C67.6172 148.281 75.3252 155.989 84.8006 155.989C94.2761 155.989 101.984 148.281 101.984 138.806V131.441H121.622V138.806C121.622 148.281 129.33 155.989 138.806 155.989C148.281 155.989 155.989 148.281 155.989 138.806C155.989 129.33 148.281 121.622 138.806 121.622H131.441V101.984H138.806C148.281 101.984 155.989 94.2761 155.989 84.8007C155.989 75.3252 148.281 67.6172 138.806 67.6172ZM131.441 92.165V84.8007C131.441 80.7257 134.731 77.4363 138.806 77.4363C142.881 77.4363 146.17 80.7257 146.17 84.8007C146.17 88.8756 142.881 92.165 138.806 92.165H131.441ZM84.8006 92.165C80.7257 92.165 77.4363 88.8756 77.4363 84.8007C77.4363 80.7257 80.7257 77.4363 84.8006 77.4363C88.8756 77.4363 92.165 80.7257 92.165 84.8007V92.165H84.8006ZM101.984 121.622V101.984H121.622V121.622H101.984ZM138.806 146.17C134.731 146.17 131.441 142.881 131.441 138.806V131.441H138.806C142.881 131.441 146.17 134.731 146.17 138.806C146.17 142.881 142.881 146.17 138.806 146.17ZM84.8006 146.17C80.7257 146.17 77.4363 142.881 77.4363 138.806C77.4363 134.731 80.7257 131.441 84.8006 131.441H92.165V138.806C92.165 142.881 88.8756 146.17 84.8006 146.17Z"
            fill="var(--surface, #ffffff)"
          />
        </svg>
      );

    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...rest}>
          <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
        </svg>
      );
  }
}
