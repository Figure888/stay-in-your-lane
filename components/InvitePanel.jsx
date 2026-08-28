import { useEffect, useState } from 'react';

/**
 * Invite screen. Drop it wherever your chip balance lives.
 *
 * Styling here is deliberately plain — swap the class names for whatever the
 * rest of Stay in Your Lane uses. The logic is the part worth keeping.
 */
export default function InvitePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/referral/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError('Could not load your invite code.'));

    return () => { cancelled = true; };
  }, []);

  async function share() {
    if (!data) return;

    const text =
      `I invented a poker variant — two lanes, three in the middle, ` +
      `and you have to play exactly two cards from your hand. ` +
      `Join me and we both get chips: ${data.link}`;

    // Native share sheet on Android, clipboard everywhere else.
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Stay in Your Lane', text, url: data.link });
        return;
      } catch {
        // user dismissed the sheet — fall through to copy
      }
    }

    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed. Long-press the code to select it.');
    }
  }

  if (error) return <p className="invite-error">{error}</p>;
  if (!data) return <p className="invite-loading">Loading your code…</p>;

  const capped = data.slotsLeft === 0;

  return (
    <section className="invite-panel">
      <h2>Invite a player, get {data.inviterBonus.toLocaleString()} chips</h2>

      <p className="invite-terms">
        They get {data.inviteeBonus.toLocaleString()} chips for joining.
        You both get paid once they've played {data.handsRequired} hands.
      </p>

      <div className="invite-code" aria-label="Your invite code">
        {data.code}
      </div>

      <button type="button" onClick={share} disabled={capped}>
        {copied ? 'Link copied' : 'Share your link'}
      </button>

      <dl className="invite-stats">
        <div>
          <dt>Joined</dt>
          <dd>{data.qualified}</dd>
        </div>
        <div>
          <dt>Still playing their first {data.handsRequired}</dt>
          <dd>{data.pending}</dd>
        </div>
        <div>
          <dt>Chips earned</dt>
          <dd>{data.chipsEarned.toLocaleString()}</dd>
        </div>
      </dl>

      {capped ? (
        <p className="invite-note">
          You've hit the invite limit. Nothing more to earn here.
        </p>
      ) : (
        <p className="invite-note">
          {data.slotsLeft} invite{data.slotsLeft === 1 ? '' : 's'} left.
        </p>
      )}
    </section>
  );
}
