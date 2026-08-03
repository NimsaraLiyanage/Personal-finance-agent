import Chat from '@/components/Chat';
import { defaultVoiceMode } from '@/lib/voice';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col px-4">
      <Chat defaultVoiceMode={defaultVoiceMode()} />
    </main>
  );
}
