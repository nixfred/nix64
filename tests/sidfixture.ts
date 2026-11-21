// A tiny SID tune made by this code, so the tests need no one else's music: song 1 plays a 440 Hz triangle wave on voice 1,
// song 2 plays 880 Hz (PAL: frequency register = Hz x 2^24 / 985248).
// Hand-assembled 6502 at $1000 (init) and $1030 (play).
export function toneSid(songs = 2): Buffer {
  // init ($1000): set volume and envelope, pick the frequency for the song in A (song number - 1) and keep it in $1100/$1101
  const init = Buffer.from([
    0xa2, 0x0f, 0x8e, 0x18, 0xd4, //  LDX #$0F : STX $D418   volume 15
    0xa2, 0x00, 0x8e, 0x05, 0xd4, //  LDX #$00 : STX $D405   attack/decay
    0xa2, 0xf0, 0x8e, 0x06, 0xd4, //  LDX #$F0 : STX $D406   sustain/release
    0xc9, 0x00, 0xd0, 0x0c, //        CMP #0 : BNE two
    0xa9, 0x45, 0x8d, 0x00, 0x11, //  LDA #$45 : STA $1100   440 Hz = $1D45
    0xa9, 0x1d, 0x8d, 0x01, 0x11, //  LDA #$1D : STA $1101
    0xd0, 0x0a, //                    BNE done
    0xa9, 0x8a, 0x8d, 0x00, 0x11, //  two: LDA #$8A : STA $1100   880 Hz = $3A8A
    0xa9, 0x3a, 0x8d, 0x01, 0x11, //  LDA #$3A : STA $1101
    0x60, //                          done: RTS
  ]);
  // play ($1030), called every frame like a real player: write the frequency, the gate and the volume again.
  // (It also keeps the register log busy, which VICE's dump device buffers in 4 KB pieces.)
  const play = Buffer.from([
    0xad, 0x00, 0x11, 0x8d, 0x00, 0xd4, // LDA $1100 : STA $D400
    0xad, 0x01, 0x11, 0x8d, 0x01, 0xd4, // LDA $1101 : STA $D401
    0xee, 0x02, 0x11, 0xd0, 0x03, 0xee, 0x03, 0x11, // INC $1102 : BNE +3 : INC $1103   a 16 bit count of play calls (the tests read it from RAM)
    0xa9, 0x11, 0x8d, 0x04, 0xd4, //       LDA #$11 : STA $D404  triangle + gate on
    0xa9, 0x0f, 0x8d, 0x18, 0xd4, //       LDA #$0F : STA $D418  volume
    0x60,
  ]);
  const body = Buffer.concat([init, Buffer.alloc(0x30 - init.length, 0x60), play]);
  const h = Buffer.alloc(0x7c);
  h.write("PSID", 0, "latin1");
  h.writeUInt16BE(2, 4); // version
  h.writeUInt16BE(0x7c, 6); // data offset
  h.writeUInt16BE(0, 8); // load address: taken from the data
  h.writeUInt16BE(0x1000, 10); // init
  h.writeUInt16BE(0x1030, 12); // play
  h.writeUInt16BE(songs, 14);
  h.writeUInt16BE(1, 16); // start song
  h.write("Nix64 test tone", 0x16, "latin1");
  h.write("Larry (Claude)", 0x36, "latin1");
  h.write("2026 Nix64 tests", 0x56, "latin1");
  h.writeUInt16BE(0x04 | 0x10, 0x76); // PAL, 6581
  return Buffer.concat([h, Buffer.from([0x00, 0x10]), body]);
}
