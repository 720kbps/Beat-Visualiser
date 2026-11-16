<script lang="ts">
  // A row of mutually exclusive options, like 15 s / 30 s / 60 s.
  // Numbers only, because that's all the app needs (lengths, fps).
  let {
    options,
    selected,
    format,
    onselect,
    disabled = false,
    label,
  }: {
    options: readonly number[]
    selected: number
    format: (option: number) => string // e.g. (s) => `${s} s`
    onselect: (option: number) => void
    disabled?: boolean
    label: string // for screen readers, e.g. "Length"
  } = $props()
</script>

<div
  class="inline-flex gap-1 rounded-lg bg-raised p-1 ring-1 ring-line ring-inset"
  role="radiogroup"
  aria-label={label}
>
  {#each options as option (option)}
    <button
      type="button"
      role="radio"
      aria-checked={option === selected}
      class={[
        'h-7 rounded-sm px-3 text-sm tabular-nums transition-colors duration-150 ease-out disabled:opacity-40',
        option === selected
          ? 'bg-accent-soft font-medium text-accent'
          : 'text-soft hover:text-fg',
      ]}
      onclick={() => onselect(option)}
      {disabled}
    >
      {format(option)}
    </button>
  {/each}
</div>
