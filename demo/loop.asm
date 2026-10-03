; 演示：循环标签 + 数据
; R1 作为计数器，从 3 递减到 0 后停机

start:
        MOVI R1, 3        ; 计数初值
loop:
        ADD  R1, R2       ; R2 恒为 0，此处仅演示双寄存器指令
        JZ   R1, done     ; R1 为 0 则跳到 done（前向引用）
        JMP  loop         ; 否则继续循环（后向引用，偏移为负）
done:
        HALT

; 数据区
counter_init:
        .word 3           ; 十进制常量
magic:  .word 0xDEADBEEF  ; 十六进制常量
