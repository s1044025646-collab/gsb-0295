; 演示：循环计数 + 数据区
; R1 从 5 递减到 0（教学用途，无真实执行）

start:
    MOVI R1, 5        ; 计数初值
loop:
    ADD R1, R1        ; 占位运算
    JZ  R0, loop      ; R0 恒为零时回跳（演示后向引用）
    JMP done          ; 前向引用

done:
    HALT

; 数据区
counter:  .word 5
limit:    .word 0x0000FFFF
padding:  .word 0
