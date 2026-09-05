/** Shared loading / failure chrome, so every viewer reports the same way. */
export function PreviewLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="preview__state">
      <span className="preview__spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function PreviewError({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="preview__state preview__state--error" role="alert">
      {message}
    </p>
  );
}

export function PreviewNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="preview__note">{children}</p>;
}
