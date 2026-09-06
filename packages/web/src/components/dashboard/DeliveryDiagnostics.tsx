export interface DeliveryDiagnostic {
  id: string;
  title: string;
  source: string;
  status: string;
  destination:
    | { kind: 'project'; projectId: string | null; projectName: string | null }
    | { kind: 'global'; topic: string | null }
    | null;
  attemptCount: number;
  providerMessageId: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

function DeliveryRow({ delivery }: { delivery: DeliveryDiagnostic }) {
  const destination = deliveryDestinationLabel(delivery);
  const color = deliveryStatusColor(delivery.status);
  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <td className="py-2 pr-4">
        <div>{delivery.title}</div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {delivery.source}
        </div>
      </td>
      <td className="py-2 pr-4 text-xs font-mono">{destination}</td>
      <td className="py-2 pr-4">
        <span style={{ color }}>{delivery.status}</span>
      </td>
      <td className="py-2 text-xs">
        <div>
          {delivery.attemptCount} attempt{delivery.attemptCount === 1 ? '' : 's'}
        </div>
        {delivery.providerMessageId ? <div>Telegram ID {delivery.providerMessageId}</div> : null}
        {delivery.lastError ? (
          <div style={{ color: 'var(--error)' }}>{delivery.lastError}</div>
        ) : null}
      </td>
    </tr>
  );
}

function deliveryDestinationLabel(delivery: DeliveryDiagnostic): string {
  if (delivery.destination?.kind === 'project') {
    return [delivery.destination.projectName, delivery.destination.projectId]
      .filter(Boolean)
      .join(' — ');
  }
  return delivery.destination?.topic ?? 'missing';
}

function deliveryStatusColor(status: string): string {
  if (status === 'delivered') return 'var(--success)';
  if (['pending', 'sending', 'batched', 'snoozed', 'included'].includes(status)) {
    return 'var(--text-muted)';
  }
  return 'var(--error)';
}

function MobileDeliveryCards({ deliveries }: { deliveries: DeliveryDiagnostic[] }) {
  return (
    <div className="space-y-3 md:hidden">
      {deliveries.map((delivery) => (
        <article
          key={delivery.id}
          aria-label={delivery.title}
          className="rounded-md border p-3 space-y-2 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">{delivery.title}</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {delivery.source}
              </div>
            </div>
            <span style={{ color: deliveryStatusColor(delivery.status) }}>{delivery.status}</span>
          </div>
          <div className="text-xs break-words">{deliveryDestinationLabel(delivery)}</div>
          <div className="text-xs break-words">
            {delivery.attemptCount} attempt{delivery.attemptCount === 1 ? '' : 's'}
            {delivery.providerMessageId ? ` · Telegram ID ${delivery.providerMessageId}` : ''}
          </div>
          {delivery.lastError ? (
            <div className="text-xs break-words" style={{ color: 'var(--error)' }}>
              {delivery.lastError}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function DeliveryTable({ deliveries }: { deliveries: DeliveryDiagnostic[] }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
            <th className="py-1.5 pr-4 font-medium">Message</th>
            <th className="py-1.5 pr-4 font-medium">Destination</th>
            <th className="py-1.5 pr-4 font-medium">Outcome</th>
            <th className="py-1.5 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((item) => (
            <DeliveryRow key={item.id} delivery={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeliveryDiagnostics({
  deliveries,
  loading,
  error,
}: {
  deliveries: DeliveryDiagnostic[];
  loading: boolean;
  error: boolean;
}) {
  let content = (
    <>
      <MobileDeliveryCards deliveries={deliveries} />
      <DeliveryTable deliveries={deliveries} />
    </>
  );
  if (error)
    content = (
      <p className="text-sm" style={{ color: 'var(--error)' }}>
        Delivery evidence temporarily unavailable
      </p>
    );
  else if (loading)
    content = (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </p>
    );
  else if (deliveries.length === 0)
    content = (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No deliveries recorded.
      </p>
    );
  return (
    <div
      className="p-4 rounded-lg space-y-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold">Notification Delivery</h2>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Provider acceptance and unresolved Telegram sends. Accepted means Telegram received the
        request; it does not mean the message was read.
      </p>
      {content}
    </div>
  );
}
