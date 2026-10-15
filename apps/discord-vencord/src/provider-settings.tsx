import type { ProviderUpdate } from "@lingo-sofa/protocol";
import { createAISettings } from "@lingo-sofa/ui-shared";
import { React } from "@webpack/common";
import type { AISettingsClient } from "@lingo-sofa/ui-shared";
const AISettings = createAISettings(() => React);
export function ProviderSettings({
  client,
  onSaved,
}: {
  client: AISettingsClient;
  onSaved: (target?: ProviderUpdate["target"]) => void;
}) {
  return (
    <section className="lingo-sofa-panel lingo-sofa-provider">
      <AISettings client={client} onSaved={onSaved} />
    </section>
  );
}
