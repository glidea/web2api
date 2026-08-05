<script lang="ts">
  import { browser } from "wxt/browser";
  import { onMount } from "svelte";

  type PopupStatus = {
    contentScriptReady: boolean;
  };

  let status: PopupStatus | undefined = $state(undefined);

  onMount((): void => {
    void loadStatus();
  });

  async function loadStatus(): Promise<void> {
    status = await browser.runtime.sendMessage({ type: "web2api:popup-status" }) as PopupStatus;
  }
</script>

<main>
  <h1>Web2API</h1>
  {#if status?.contentScriptReady}
    <p>Content script ready</p>
  {:else}
    <p>Content script unavailable</p>
  {/if}
</main>
<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
  }

  main {
    width: 240px;
    padding: 16px;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }

  p {
    margin: 0;
    color: #555;
    font-size: 13px;
  }
</style>
