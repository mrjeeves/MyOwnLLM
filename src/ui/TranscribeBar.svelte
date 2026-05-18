<script lang="ts">
  import ModelSelector from "./ModelSelector.svelte";
  import type { Mode } from "../types";

  let {
    activeModel,
    activeFamily,
    activeMode,
    kind,
    viaDevicePubkey,
    onViaChange,
    disabled = false,
  } = $props<{
    activeModel: string;
    activeFamily: string;
    activeMode: Mode;
    /** "transcribe" routes through the ASR-peer pool; "text" routes
     *  through the LLM-peer pool. The talking-points bar passes
     *  "text" because TP runs the chat model on the receiving end. */
    kind: "text" | "transcribe";
    /** Stable pubkey of the routing target. Survives reconnects. */
    viaDevicePubkey: string | null;
    onViaChange: (devicePubkey: string | null) => void;
    disabled?: boolean;
  }>();
</script>

<div class="transcribe-bar">
  <ModelSelector
    {kind}
    localModel={activeModel}
    family={activeFamily}
    mode={activeMode}
    {viaDevicePubkey}
    {onViaChange}
    {disabled}
  />
</div>

<style>
  .transcribe-bar {
    display: flex;
    align-items: center;
    padding: .45rem .75rem;
    background: #0f0f0f;
    border-top: 1px solid #1a1a1a;
  }
</style>
