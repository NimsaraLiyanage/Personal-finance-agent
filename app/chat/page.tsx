import Chat from '@/components/Chat';
import { defaultVoiceMode } from '@/lib/voice';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    // A white column on the grey page: the gutters give the chat a visible
    // edge instead of letting it bleed into the browser chrome.
    <main className="mx-auto flex h-full max-w-3xl flex-col border-line bg-surface px-4 sm:border-x sm:px-6 sm:shadow-card">
      <Chat defaultVoiceMode={defaultVoiceMode()} />
    </main>
  );
}
