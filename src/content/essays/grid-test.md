---
title: Grid test
date: "2026-04-19"
kind: TEST
summary: 临时页 —— 检验 ripple 网格波动提示。验证完可以删除。
tint: mist
stage: begin
---

<section data-cue="empty">

empty —— 静止的水面。

</section>

<section data-cue="sq-rows">

sq-rows —— 方阵网格上的涟漪，一道波自上而下，约每 3.6 秒重复一次。

</section>

<section data-cue="sq-cols">

sq-cols —— 同样的方阵，波从左到右。

</section>

<section data-cue="sq-diag">

sq-diag —— 方阵上的对角扫过。

</section>

<section data-cue="hex-rows">

hex-rows —— 六边形网格，逐行扫过。行间错位让波前呈现出梅花五点的质感。

</section>

<section data-cue="hex-diag">

hex-diag —— 六边形 + 对角。

</section>

<section data-cue="large">

large —— 接下来的涟漪半径放大到约 155%。这里保留上一条网格提示（hex-diag），因为尺寸修饰符不会改变当前生效的网格。

</section>

<section data-cue="sq-rows">

sq-rows 叠加 large —— 方阵逐行扫过，但每个涟漪更大一点。

</section>

<section data-cue="small">

small —— 缩小到约 55%。

</section>

<section data-cue="hex-cols">

hex-cols + small —— 小涟漪，六边形逐列扫过。

</section>

<section data-cue="drop">

drop —— 回到单点居中的一滴。它会延续当前的尺寸修饰符（small），所以这一滴收敛得很内敛。

</section>

<section data-cue="empty">

empty —— 淡出。

</section>
