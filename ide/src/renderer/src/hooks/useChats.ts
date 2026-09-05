import { useCallback, useEffect, useRef, useState } from "react";

import type { Chat, ChatId, ChatSummary, DocumentRef, Message } from "@shared/types.js";
import { isTerminalRunState } from "@shared/types.js";

export interface ChatsController {
  chats: ChatSummary[];
  activeChat: Chat | null;
  isLoading: boolean;
  /** True while the agent is producing the last reply in the active chat. */
  isStreaming: boolean;
  error: string | null;
  selectChat: (chatId: ChatId) => void;
  newChat: () => void;
  deleteChat: (chatId: ChatId) => void;
  renameChat: (chatId: ChatId, title: string) => void;
  send: (prompt: string, attachments?: DocumentRef[]) => void;
  cancel: () => void;
  dismissError: () => void;
}

/**
 * Owns the conversation state the whole UI reads from.
 *
 * Nothing here polls. The main process pushes every change over the event
 * bridge, so the reducer-ish updates below are the only place chat state
 * moves, and a slow streaming backend behaves the same as the fast scripted
 * stand-in.
 */
export function useChats(): ChatsController {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Events arrive for every chat, but only the open one is held in state. A
  // ref keeps the filter current without re-subscribing on each change.
  const activeChatIdRef = useRef<ChatId | null>(null);
  const setActive = useCallback((chat: Chat | null) => {
    activeChatIdRef.current = chat?.id ?? null;
    setActiveChat(chat);
  }, []);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  // Initial load: show the most recent conversation, or start a fresh one.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const summaries = await window.workbench.chat.list();
        if (cancelled) return;
        setChats(summaries);

        const mostRecent = summaries[0];
        const chat = mostRecent
          ? await window.workbench.chat.get(mostRecent.id)
          : await window.workbench.chat.create();
        if (cancelled) return;

        setActive(chat);
        if (!mostRecent && chat) setChats([toSummary(chat)]);
      } catch (cause) {
        if (!cancelled) report(cause);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [report, setActive]);

  // Main-process event stream.
  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        switch (event.type) {
          case "chat/list-changed":
            setChats(event.chats);
            break;

          case "chat/message-appended":
            if (event.chatId !== activeChatIdRef.current) break;
            setActiveChat((current) =>
              current ? { ...current, messages: [...current.messages, event.message] } : current,
            );
            break;

          case "chat/message-updated":
            if (event.chatId !== activeChatIdRef.current) break;
            setActiveChat((current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.map((message) =>
                      message.id === event.messageId ? event.message : message,
                    ),
                  }
                : current,
            );
            break;

          case "browser/state-changed":
            break; // Handled by useBrowserPane.
        }
      }),
    [],
  );

  const selectChat = useCallback(
    (chatId: ChatId) => {
      if (chatId === activeChatIdRef.current) return;
      window.workbench.chat
        .get(chatId)
        .then(setActive)
        .catch(report);
    },
    [report, setActive],
  );

  const newChat = useCallback(() => {
    window.workbench.chat.create().then(setActive).catch(report);
  }, [report, setActive]);

  const deleteChat = useCallback(
    (chatId: ChatId) => {
      void (async () => {
        try {
          await window.workbench.chat.remove(chatId);
          if (chatId !== activeChatIdRef.current) return;

          // The deleted chat was open, so fall back to the next most recent —
          // or a brand new one if that was the last chat.
          const remaining = await window.workbench.chat.list();
          const next = remaining[0];
          setActive(next ? await window.workbench.chat.get(next.id) : await window.workbench.chat.create());
        } catch (cause) {
          report(cause);
        }
      })();
    },
    [report, setActive],
  );

  const renameChat = useCallback(
    (chatId: ChatId, title: string) => {
      window.workbench.chat.rename(chatId, title).catch(report);
      setActiveChat((current) => (current?.id === chatId ? { ...current, title } : current));
    },
    [report],
  );

  const send = useCallback(
    (prompt: string, attachments: DocumentRef[] = []) => {
      const chatId = activeChatIdRef.current;
      if (!chatId) return;
      // The appended message arrives over the event bridge, so nothing is
      // added to state here — that would duplicate the turn.
      window.workbench.chat.send(chatId, prompt, attachments).catch(report);
    },
    [report],
  );

  const cancel = useCallback(() => {
    const chatId = activeChatIdRef.current;
    if (chatId) window.workbench.chat.cancel(chatId).catch(report);
  }, [report]);

  return {
    chats,
    activeChat,
    isLoading,
    isStreaming: activeChat ? isAwaitingAgent(activeChat.messages) : false,
    error,
    selectChat,
    newChat,
    deleteChat,
    renameChat,
    send,
    cancel,
    dismissError: () => setError(null),
  };
}

/**
 * True when the final message is an agent turn that has not reached a terminal
 * status — which is what drives the composer's stop button.
 */
function isAwaitingAgent(messages: Message[]): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "agent") return false;

  const status = last.blocks.findLast((block) => block.kind === "status");
  return status ? !isTerminalRunState(status.state) : true;
}

function toSummary(chat: Chat): ChatSummary {
  const { messages: _messages, ...summary } = chat;
  return summary;
}
