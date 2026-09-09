import { Icon } from "./Icon.js";
import { IconButton } from "./IconButton.js";

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}

/** Search input with a leading glyph and a clear affordance once it has text. */
export function SearchField({
  value,
  onChange,
  placeholder = "Search",
  label,
  className = "",
}: SearchFieldProps): React.JSX.Element {
  return (
    <div className={`field-group ${value ? "field-group--clearable" : ""} ${className}`}>
      <Icon name="search" size={14} className="field-group__icon" />
      <input
        className="field"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
      />
      {value && (
        <IconButton
          icon="close"
          label="Clear search"
          size="sm"
          hideTooltip
          onClick={() => onChange("")}
          className="field-group__clear"
        />
      )}
    </div>
  );
}
