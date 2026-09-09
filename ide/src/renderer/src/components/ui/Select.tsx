import { Icon } from "./Icon.js";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
}

/**
 * A native `<select>` wearing the app's chrome.
 *
 * Deliberately native: the option list is drawn by the OS, which means it
 * escapes the window, handles type-ahead, and behaves correctly with a screen
 * reader — none of which a hand-rolled listbox gets for free. Only the closed
 * control is restyled, and the chevron is a real element because Chromium
 * renders `appearance` differently per platform.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  className = "",
}: SelectProps): React.JSX.Element {
  return (
    <span className={`select ${className}`}>
      <select
        className="select__control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={12} className="select__chevron" />
    </span>
  );
}
