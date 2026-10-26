import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import {
  localAgentFailureMessage,
  localAgentProgress,
  reduceLiveMessageBlocks,
} from "@rakazo/core";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { ComposerError } from "../../src/pages/shell/composer-error";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

// Drive the production transcript with deterministic offline progress events.
function ProgressFixture() {
  const [blocks, setBlocks] = useState<MessageBlock[]>([
    { kind: "progress", text: localAgentProgress.connecting, activity: true },
  ]);
  const [running, setRunning] = useState(true);
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stages = [localAgentProgress.waiting, "Fixture public summary", localAgentProgress.limited];
  const message: ThreadMessage = {
    id: "progress:run-1",
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const controls = (
    <>
      <button
        type="button"
        onClick={() => {
          setRunning(false);
          setBlocks([]);
          setFailed(true);
        }}
      >
        Occupied session fixture
      </button>
      <ComposerError
        sendError={null}
        runError={failed ? localAgentFailureMessage("failed", "local_session_in_use") : null}
        runErrorId={failed ? "run-1" : null}
        onRunErrorPresented={() => {}}
        onOpenModels={() => {}}
        onDismissError={() => setFailed(false)}
        textareaRef={textareaRef}
      />
      <button
        type="button"
        onClick={() => {
          setBlocks((prior) =>
            reduceLiveMessageBlocks(prior, {
              type: "progress",
              payload: { text: stages[step], activity: true },
            }),
          );
          setStep((prior) => Math.min(2, prior + 1));
        }}
      >
        Next fixture event
      </button>
      <button
        type="button"
        onClick={() => {
          setRunning(false);
          setBlocks([]);
        }}
      >
        Stop fixture
      </button>
    </>
  );
  return (
    <FixtureTranscript
      messages={[message]}
      running={running}
      showToolActivity={false}
      header={controls}
    />
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <ProgressFixture />
    </I18nProvider>,
  );
});
