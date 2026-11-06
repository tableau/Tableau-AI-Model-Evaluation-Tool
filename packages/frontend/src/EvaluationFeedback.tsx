import React from 'react';
import { Card, Space, Text } from './ui';
import { ClockCircleOutlined, LoadingOutlined } from './ui/icons';

/** Presentation only: no inferred execution state and no writes to run stores. */
export function EvaluationFeedback({ pending, status, phase, reconnecting }: {
  pending?: string;
  status?: string;
  phase?: unknown;
  reconnecting?: boolean;
}) {
  const preparing = status === 'started' && typeof phase === 'string' && Boolean(phase);
  const text = pending || (reconnecting
    ? 'Reconnecting to live updates. Showing the last confirmed evaluation state.'
    : status === 'queued'
    ? 'Evaluation queued. Waiting for the worker to become available; this includes any previous evaluation still stopping.'
    : preparing ? `${phase}…` : null);
  if (!text) return null;
  return <Card size="small" style={{ marginBottom: 16 }}>
    <div role="status" aria-live="polite">
      <Space>
        {pending || preparing || reconnecting ? <LoadingOutlined /> : <ClockCircleOutlined />}
        <Text type="secondary">{text}</Text>
      </Space>
    </div>
  </Card>;
}
