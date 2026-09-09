import { Icon } from "../ui/Icon.js";

/** Shared loading / failure chrome, so every viewer reports the same way. */
export function PreviewLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="preview__state">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function PreviewError({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="preview__state preview__state--error" role="alert">
      <Icon name="alert-circle" size={14} />
      {message}
    </p>
  );
}

export function PreviewNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="preview__note">
      <Icon name="alert-circle" size={12} />
      <span>{children}</span>
    </p>
  );
}
