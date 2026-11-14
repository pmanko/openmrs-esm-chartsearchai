import { Component, type ComponentType, type FC, type ReactNode, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type OmnibarProviderProps, type OmnibarReport } from '../omnibar-contract/types';

interface BoundaryProps {
  name: string;
  query: string;
  onError: () => void;
  children: ReactNode;
}

class ProviderErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    console.error(`Omnibar provider ${this.props.name} failed with Error`);
    this.props.onError();
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.query !== this.props.query) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function withProviderBoundary(
  Provider: ComponentType<OmnibarProviderProps>,
  name = Provider.displayName ?? Provider.name,
) {
  const Bounded: FC<Partial<OmnibarProviderProps>> = (props) => {
    const { t } = useTranslation();
    const { query, context, report } = props;
    const lastTitle = useRef<string>();
    const recordTitle = useCallback(
      (result: OmnibarReport) => {
        lastTitle.current = result.title;
        report?.(result);
      },
      [report],
    );

    if (typeof query !== 'string' || !context || typeof report !== 'function') {
      return null;
    }
    const onError = () => report({ query, status: 'error', title: lastTitle.current ?? t('results', 'Results') });

    return (
      <ProviderErrorBoundary name={name} query={query} onError={onError}>
        <Provider {...(props as OmnibarProviderProps)} report={recordTitle} />
      </ProviderErrorBoundary>
    );
  };
  Bounded.displayName = `withProviderBoundary(${name})`;
  return Bounded;
}
