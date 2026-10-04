import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Skeleton, Textarea, cn } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { useToast } from '../../components/toast';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { providerLabel } from '../publishing/channel-connect';
import { IN_FLIGHT, REPLY_STATE_CHIP, replyLength, shortTime } from './community-helpers';
import {
  useConversation,
  useConversations,
  type ConversationItemDto,
  type ConversationViewDto,
  type ThreadItemDto,
} from './use-community';

/**
 * Comment inbox: the comments on the brand's published posts, one conversation per post, beside the one being
 * read. A conversation is threaded by parent; the brand's replies show their state (sending, sent, not posted with
 * the reason, may have posted). People with inbox.respond see who wrote each comment and can answer it; the reply
 * is posted on the platform by the server. Stacked at phone width.
 */
export function InboxScreen() {
  const { brandId } = useBrandContext();
  const conversations = useConversations(brandId);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('conversation');
  const select = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('conversation', id);
    setParams(p, { replace: true });
  };
  const items = conversations.items;

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="inbox-title"
        className="flex shrink-0 flex-col border-border lg:w-96 lg:border-r"
      >
        <div className="flex flex-col gap-3 px-4 pb-3 pt-6 sm:px-6">
          <div className="flex items-start justify-between gap-2">
            <h1 id="inbox-title" className="text-xl font-semibold">
              Inbox
            </h1>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void conversations.refetch()}
              disabled={conversations.isFetching}
            >
              {conversations.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Comments on the posts published from here, newest activity first. Replies are posted on the
            channel as the brand.
          </p>
        </div>
        <div className="border-t border-border">
          {conversations.isPending && (
            <div className="p-4">
              <Skeleton label="Loading conversations" lines={4} />
            </div>
          )}
          {conversations.isError && (
            <div className="p-4">
              <RequestError
                error={conversations.error}
                onRetry={() => void conversations.refetch()}
                title={
                  toUiError(conversations.error).kind === 'forbidden'
                    ? 'Restricted access: you cannot see this brand’s comments'
                    : undefined
                }
              />
            </div>
          )}
          {conversations.isSuccess && items.length === 0 && (
            <div className="p-4">
              <EmptyState
                title="No comments yet"
                description="Comments appear here once they are collected from the posts this brand published."
              />
            </div>
          )}
          {conversations.isSuccess && items.length > 0 && (
            <ul
              className="flex flex-col divide-y divide-border"
              aria-label="Conversations"
              data-testid="conversations"
            >
              {items.map((c) => (
                <li key={c.id}>
                  <ConversationRow
                    conversation={c}
                    selected={c.id === selectedId}
                    onSelect={() => select(c.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {conversations.isSuccess && (
            <LoadMore
              shown={items.length}
              hasNextPage={conversations.hasNextPage}
              isFetchingNextPage={conversations.isFetchingNextPage}
              onLoadMore={() => void conversations.fetchNextPage()}
              noun={items.length === 1 ? 'conversation' : 'conversations'}
              className="border-t border-border px-4 py-2 sm:px-6"
            />
          )}
        </div>
      </section>
      <div className="min-w-0 flex-1 border-t border-border px-4 py-6 sm:px-8 lg:border-t-0">
        <ConversationDetail conversationId={selectedId} />
      </div>
    </main>
  );
}

function ConversationRow({
  conversation: c,
  selected,
  onSelect,
}: {
  conversation: ConversationItemDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      data-testid={`conversation-${c.id}`}
      className={cn(
        'flex w-full flex-col gap-1.5 px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6',
        selected ? 'bg-secondary' : 'hover:bg-muted',
      )}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{c.postExcerpt ?? 'Published post'}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {c.commentCount} comment{c.commentCount === 1 ? '' : 's'}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {providerLabel(c.channel.providerKey)} · {c.channel.displayName}
      </span>
      {c.latest && (
        <span className="min-w-0 text-xs">
          {c.latest.authorHandle && <span className="font-medium">{c.latest.authorHandle}: </span>}
          <span className="text-muted-foreground">{c.latest.text}</span>
        </span>
      )}
    </button>
  );
}

function ConversationDetail({ conversationId }: { conversationId: string | null }) {
  const view = useConversation(conversationId);
  if (conversationId === null)
    return (
      <EmptyState
        title="Choose a conversation"
        description="Pick a post on the left to read its comments and answer them."
      />
    );
  if (view.isPending) return <Skeleton label="Loading comments" lines={5} />;
  if (view.isError) return <RequestError error={view.error} onRetry={() => void view.refetch()} />;
  return <Conversation view={view.data} refetch={() => void view.refetch()} />;
}

function Conversation({ view, refetch }: { view: ConversationViewDto; refetch: () => void }) {
  const { conversation: c } = view;
  const inFlight = view.items.some((i) => i.replyState !== null && IN_FLIGHT.has(i.replyState));
  return (
    <section aria-labelledby="conversation-title" className="flex flex-col gap-4" data-testid="conversation">
      <header className="flex flex-col gap-1">
        <h2 id="conversation-title" className="text-lg font-semibold">
          {c.postExcerpt ?? 'Published post'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {providerLabel(c.channel.providerKey)} · {c.channel.displayName}
          {c.postUrl && (
            <>
              {' · '}
              <a href={c.postUrl} target="_blank" rel="noreferrer" className="underline">
                Open post (new tab)
              </a>
            </>
          )}
        </p>
        {!view.canRespond && (
          <p className="text-xs text-muted-foreground" data-testid="read-only-note">
            Read only: answering comments and seeing who wrote them needs the inbox permission.
          </p>
        )}
        {view.canRespond && !c.channel.replySupported && !c.channel.replyUncertified && (
          <p className="text-xs text-muted-foreground">This channel does not support replies to comments.</p>
        )}
        {view.canRespond && c.channel.replyUncertified && (
          <p className="text-xs text-muted-foreground" data-testid="reply-uncertified">
            Replies on this channel are not certified yet: they have not been exercised against the platform,
            so Oremedia does not send them.
          </p>
        )}
        {inFlight && (
          <div>
            <Button size="sm" variant="ghost" onClick={refetch}>
              Check reply status
            </Button>
          </div>
        )}
      </header>
      {view.items.length === 0 ? (
        <EmptyState title="No comments" description="This post has no comments collected yet." />
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Comments" data-testid="thread">
          {view.items.map((item) => (
            <li key={item.id} style={{ marginInlineStart: `${Math.min(item.depth, 4) * 1.25}rem` }}>
              <ThreadEntry
                item={item}
                canReply={view.canReply}
                maxLength={c.channel.replyMaxLength}
                channelName={c.channel.displayName}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ThreadEntry({
  item,
  canReply,
  maxLength,
  channelName,
}: {
  item: ThreadItemDto;
  canReply: boolean;
  maxLength: number | null;
  channelName: string;
}) {
  const [replying, setReplying] = useState(false);
  const outbound = item.direction === 'outbound';
  const chip = item.replyState ? REPLY_STATE_CHIP[item.replyState] : null;
  return (
    <article
      className={cn(
        'flex flex-col gap-1.5 rounded-md border p-3 text-sm',
        outbound ? 'border-border bg-muted' : 'border-border',
      )}
      data-testid={`thread-${item.id}`}
      aria-label={outbound ? 'Brand reply' : 'Comment'}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {outbound ? 'Brand reply' : (item.authorHandle ?? 'Comment')}
        </span>
        <time dateTime={item.at}>{shortTime(item.at)}</time>
        {chip && (
          <Badge tone={chip.tone} data-testid="reply-state">
            {chip.label}
          </Badge>
        )}
      </p>
      <p className="whitespace-pre-wrap break-words">{item.text}</p>
      {item.failure && (
        <p className="text-xs text-status-critical" data-testid="reply-failure">
          {item.replyState === 'outcome_unknown'
            ? 'The channel did not confirm this reply; check the post before sending it again.'
            : `Not posted: ${item.failure.detail || item.failure.code}`}
        </p>
      )}
      {!outbound && canReply && !replying && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setReplying(true)}>
            Reply
          </Button>
        </div>
      )}
      {!outbound && canReply && replying && (
        <ReplyForm
          messageId={item.id}
          to={item.authorHandle}
          maxLength={maxLength}
          channelName={channelName}
          onDone={() => setReplying(false)}
        />
      )}
    </article>
  );
}

/** One reply intent: the idempotency key survives a retry of the same text and is renewed once it is queued. */
function ReplyForm({
  messageId,
  to,
  maxLength,
  channelName,
  onDone,
}: {
  messageId: string;
  to: string | null;
  maxLength: number | null;
  channelName: string;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const intent = useIntentKey();
  const send = useMutation(
    trpc.community.reply.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setText('');
        setError(null);
        void queryClient.invalidateQueries(trpc.community.pathFilter());
        toast({ tone: 'good', title: 'Reply queued', description: `It is being posted on ${channelName}.` });
        onDone();
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );
  const length = replyLength(text);
  const tooLong = maxLength !== null && length > maxLength;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (length === 0) {
      setError('Write a reply first.');
      return;
    }
    if (tooLong) {
      setError(`${channelName} allows ${maxLength} characters.`);
      return;
    }
    setError(null);
    send.mutate({ messageId, text: text.trim() });
  };
  const id = `reply-${messageId}`;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate data-testid="reply-form">
      <Field
        label={to ? `Reply to ${to}` : 'Reply'}
        htmlFor={id}
        hint={maxLength !== null ? `${length} / ${maxLength} characters` : undefined}
        error={error ?? undefined}
      >
        <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send reply'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={send.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
