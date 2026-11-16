<script lang="ts">
  // One numbered card in the control panel: "1  Beat", "2  Section", ...
  // `aside` is an optional snippet shown on the right of the header (a count,
  // a time range). `highlight` marks the step that matters most (recording).
  import type { Snippet } from 'svelte'

  let {
    n,
    title,
    highlight = false,
    aside,
    children,
  }: {
    n?: number // no number: an unnumbered card (Export)
    title: string
    highlight?: boolean
    aside?: Snippet
    children: Snippet
  } = $props()
</script>

<section
  class={[
    'flex flex-col gap-4 rounded-2xl border bg-surface p-5',
    highlight ? 'border-accent/25' : 'border-line',
  ]}
>
  <header class="flex min-h-6 items-center gap-3">
    {#if n}
      <span
        class={[
          'grid size-6 shrink-0 place-items-center rounded-full font-mono text-xs',
          highlight ? 'bg-accent-soft text-accent' : 'bg-raised text-soft',
        ]}
      >
        {n}
      </span>
    {/if}
    <h2 class="text-sm font-semibold">{title}</h2>
    {#if aside}
      <div class="ml-auto min-w-0 text-xs text-muted">{@render aside()}</div>
    {/if}
  </header>
  {@render children()}
</section>
