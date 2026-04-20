---
title: grid test
date: "2026-04-19"
kind: TEST
summary: throwaway — exercises the ripple grid-wave cues. delete after verifying.
tint: mist
stage: begin
---

<section data-cue="empty">

empty — quiet surface.

</section>

<section data-cue="sq-rows">

sq-rows — ripples on a square lattice, a wave travels top to bottom, then repeats every ~3.6s.

</section>

<section data-cue="sq-cols">

sq-cols — same lattice, wave left to right.

</section>

<section data-cue="sq-diag">

sq-diag — diagonal sweep on the square lattice.

</section>

<section data-cue="hex-rows">

hex-rows — hexagonal lattice, row sweep. Row offset gives a quincunx feel at wave front.

</section>

<section data-cue="hex-diag">

hex-diag — hex + diagonal.

</section>

<section data-cue="large">

large — next ripples use ~155% radius. This section keeps the previous grid cue (hex-diag) since size modifiers don't change the active cue.

</section>

<section data-cue="sq-rows">

sq-rows with large still in effect — bigger ripples on the square row sweep.

</section>

<section data-cue="small">

small — shrink to ~55%.

</section>

<section data-cue="hex-cols">

hex-cols + small — tiny ripples, hex column sweep.

</section>

<section data-cue="drop">

drop — back to a single centered ripple. It respects the current size modifier (small), so this drop is subdued.

</section>

<section data-cue="empty">

empty — fade out.

</section>
