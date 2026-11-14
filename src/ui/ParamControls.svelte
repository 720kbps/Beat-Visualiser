<script lang="ts">
  // Builds the controls for a theme from its param schema:
  // number -> slider, color -> color picker, toggle -> checkbox.
  //
  // How the values get back to the parent: `values` is $bindable, and the parent
  // passes its own $state object with bind:
  //
  //   let params = $state(defaultParams(theme.params))
  //   <ParamControls schema={theme.params} bind:values={params} />
  //
  // A $state object is a deep reactive proxy, so when this component sets
  // values[id] = x, the parent's `params` object itself changes (it's the same
  // object). bind: is what tells Svelte the child is allowed to change it;
  // without bind: Svelte warns about mutating a prop the child doesn't own.
  // The render loop can read params[id] directly every frame; reading a $state
  // object outside an $effect is just a normal property read.
  import type {
    ParamDef,
    ParamSchema,
    ParamValues,
  } from '../engine/visualizers/types'

  let {
    schema,
    values = $bindable(),
  }: { schema: ParamSchema; values: ParamValues } = $props()

  // The current value with the right type. Falls back to the default if the
  // value is missing or has the wrong type (e.g. values from an older schema).
  function numberValue(def: ParamDef & { type: 'number' }): number {
    const v = values[def.id]
    return typeof v === 'number' ? v : def.default
  }
  function colorValue(def: ParamDef & { type: 'color' }): string {
    const v = values[def.id]
    return typeof v === 'string' ? v : def.default
  }
  function toggleValue(def: ParamDef & { type: 'toggle' }): boolean {
    const v = values[def.id]
    return typeof v === 'boolean' ? v : def.default
  }

  // Show as many decimals as the step has: step 0.01 -> "0.50", step 1 -> "3"
  function formatNumber(value: number, step: number): string {
    const text = String(step)
    const dot = text.indexOf('.')
    const decimals = dot === -1 ? 0 : text.length - dot - 1
    return value.toFixed(decimals)
  }
</script>

<div class="flex flex-col gap-2 text-sm">
  {#each schema as def (def.id)}
    <label class="grid grid-cols-[7rem_1fr_3rem] items-center gap-2">
      <span class="truncate">{def.label}</span>

      {#if def.type === 'number'}
        <input
          type="range"
          min={def.min}
          max={def.max}
          step={def.step}
          value={numberValue(def)}
          oninput={(e) => (values[def.id] = e.currentTarget.valueAsNumber)}
        />
        <span class="text-right tabular-nums">
          {formatNumber(numberValue(def), def.step)}
        </span>
      {:else if def.type === 'color'}
        <input
          type="color"
          class="h-6 w-12 cursor-pointer"
          value={colorValue(def)}
          oninput={(e) => (values[def.id] = e.currentTarget.value)}
        />
      {:else if def.type === 'toggle'}
        <input
          type="checkbox"
          class="justify-self-start"
          checked={toggleValue(def)}
          onchange={(e) => (values[def.id] = e.currentTarget.checked)}
        />
      {/if}
    </label>
  {/each}
</div>
