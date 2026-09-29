# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pandas", "pyarrow"]
# ///
"""Download the FlyWire v783 connectome and pack it for the browser.

Sources
  - Shiu et al. 2024 whole-brain LIF model inputs (neuron order + signed connectivity):
    https://github.com/philshiu/Drosophila_brain_model
  - FlyWire cell-type annotations (Schlegel et al. 2024):
    https://github.com/flyconnectome/flywire_annotations

Output (public/data/brain/)
  meta.json          sizes, vocabularies, named neuron groups
  graph.bin.gz       CSR by presynaptic neuron: indptr u32[N+1] | post deltas (varint) | signed synapse counts (zigzag varint)
  neurons.bin.gz     type u16[N] | superclass u8[N] | cls u8[N] | side u8[N] | nt u8[N] | soma f32[N*3] | anchor f32[N*3]

Raw downloads are cached outside the project (default ~/.cache/doodle-fly, override with DOODLE_FLY_CACHE).
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "brain"
CACHE = Path(os.environ.get("DOODLE_FLY_CACHE", Path.home() / ".cache" / "doodle-fly"))

SOURCES = {
    "Completeness_783.csv": "https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/Completeness_783.csv",
    "Connectivity_783.parquet": "https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/Connectivity_783.parquet",
    "Supplemental_file1_neuron_annotations.tsv": "https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv",
}

SIDES = {"left": 1, "right": 2, "center": 3}
NTS = ["unknown", "acetylcholine", "gaba", "glutamate", "dopamine", "serotonin", "octopamine"]

# Named groups the app stimulates or reads out. (cell_type, side) or (column, value, side).
GROUPS = {
    # visual small-object detectors (input for steering)
    "LC10a_L": ("cell_type", "LC10a", "left"),
    "LC10a_R": ("cell_type", "LC10a", "right"),
    # looming detectors (input when falling)
    "LPLC2_L": ("cell_type", "LPLC2", "left"),
    "LPLC2_R": ("cell_type", "LPLC2", "right"),
    "LC4_L": ("cell_type", "LC4", "left"),
    "LC4_R": ("cell_type", "LC4", "right"),
    # steering relays / descending neurons (readout)
    "AOTU019_L": ("cell_type", "AOTU019", "left"),
    "AOTU019_R": ("cell_type", "AOTU019", "right"),
    "AOTU025_L": ("cell_type", "AOTU025", "left"),
    "AOTU025_R": ("cell_type", "AOTU025", "right"),
    "DNa02_L": ("cell_type", "DNa02", "left"),
    "DNa02_R": ("cell_type", "DNa02", "right"),
    "DNa01_L": ("cell_type", "DNa01", "left"),
    "DNa01_R": ("cell_type", "DNa01", "right"),
    "DNp01_L": ("cell_type", "DNp01", "left"),
    "DNp01_R": ("cell_type", "DNp01", "right"),
    # taste -> proboscis (Shiu et al. 2024 main result)
    "sugar_GRN_L": ("cell_sub_class", "sugar", "left"),
    "sugar_GRN_R": ("cell_sub_class", "sugar", "right"),
    "proboscis_MN": ("cell_sub_class", "proboscis_motor_neuron", None),
}


def fetch(name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"downloading {name} ...", flush=True)
        tmp = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(SOURCES[name], tmp)
        tmp.replace(path)
    return path


def varint(values: np.ndarray) -> bytes:
    """LEB128-encode non-negative integers (vectorised)."""
    v = values.astype(np.uint64)
    nbytes = np.ones(len(v), dtype=np.int64)
    t = v >> np.uint64(7)
    while t.any():
        nbytes += t > 0
        t >>= np.uint64(7)
    out = np.zeros(int(nbytes.sum()), dtype=np.uint8)
    pos = np.concatenate([[0], np.cumsum(nbytes)[:-1]])
    rest = v.copy()
    for k in range(int(nbytes.max())):
        m = nbytes > k
        byte = (rest[m] & np.uint64(0x7F)).astype(np.uint8)
        more = nbytes[m] > k + 1
        out[pos[m] + k] = byte | (more.astype(np.uint8) << 7)
        rest[m] >>= np.uint64(7)
    return out.tobytes()


def main() -> None:
    comp = pd.read_csv(fetch("Completeness_783.csv"), index_col=0)
    con = pd.read_parquet(fetch("Connectivity_783.parquet"))
    ann = pd.read_csv(
        fetch("Supplemental_file1_neuron_annotations.tsv"),
        sep="\t",
        low_memory=False,
        dtype={"root_id": "int64", "supervoxel_id": "Int64"},
    )
    ann = ann.drop_duplicates("root_id").set_index("root_id")

    n = len(comp)
    ids = comp.index.to_numpy(dtype=np.int64)
    a = ann.reindex(ids)
    print(f"neurons {n:,}  connections {len(con):,}  annotated {a.super_class.notna().sum():,}")

    # --- connectivity: CSR by presynaptic index -------------------------------------------
    pre = con["Presynaptic_Index"].to_numpy(np.int64)
    post = con["Postsynaptic_Index"].to_numpy(np.int64)
    w = con["Excitatory x Connectivity"].to_numpy(np.int64)
    order = np.lexsort((post, pre))
    pre, post, w = pre[order], post[order], w[order]
    indptr = np.zeros(n + 1, dtype=np.uint32)
    np.add.at(indptr, pre + 1, 1)
    indptr = np.cumsum(indptr, dtype=np.uint64).astype(np.uint32)

    row_start = np.repeat(indptr[:-1].astype(np.int64), np.diff(indptr).astype(np.int64))
    prev = np.empty_like(post)
    prev[0] = 0
    prev[1:] = post[:-1]
    first = np.arange(len(post)) == row_start
    delta = np.where(first, post, post - prev)
    assert (delta >= 0).all()
    zig = np.where(w >= 0, w * 2, -w * 2 - 1)

    post_bytes = varint(delta)
    w_bytes = varint(zig)
    graph = indptr.tobytes() + post_bytes + w_bytes

    # --- neuron metadata -------------------------------------------------------------------
    def vocab(col: str, first: str = "") -> tuple[list[str], np.ndarray]:
        s = a[col].fillna(first).astype(str)
        names = [first] + sorted(set(s) - {first})
        lut = {k: i for i, k in enumerate(names)}
        return names, s.map(lut).to_numpy()

    types, type_idx = vocab("cell_type")
    superclasses, sc_idx = vocab("super_class", "unknown")
    classes, cls_idx = vocab("cell_class")
    assert len(types) < 65536 and len(superclasses) < 256 and len(classes) < 256
    side = a["side"].map(SIDES).fillna(0).to_numpy(np.uint8)
    nt = a["top_nt"].map({k: i for i, k in enumerate(NTS)}).fillna(0).to_numpy(np.uint8)

    voxel = np.array([4.0, 4.0, 40.0]) / 1000.0  # voxel -> micrometres
    anchor = a[["pos_x", "pos_y", "pos_z"]].to_numpy(float) * voxel
    soma = a[["soma_x", "soma_y", "soma_z"]].to_numpy(float) * voxel
    soma = np.where(np.isnan(soma), anchor, soma)
    centre = np.nanmean(anchor, axis=0)
    anchor = np.where(np.isnan(anchor), centre, anchor)
    soma = np.where(np.isnan(soma), centre, soma)

    neurons = b"".join(
        [
            type_idx.astype(np.uint16).tobytes(),
            sc_idx.astype(np.uint8).tobytes(),
            cls_idx.astype(np.uint8).tobytes(),
            side.tobytes(),
            nt.tobytes(),
            soma.astype(np.float32).tobytes(),
            anchor.astype(np.float32).tobytes(),
        ]
    )

    groups = {}
    for name, (col, value, sd) in GROUPS.items():
        m = a[col] == value
        if sd:
            m &= a["side"] == sd
        idx = np.flatnonzero(m.to_numpy())
        groups[name] = idx.tolist()
        print(f"  group {name:14s} {len(idx):4d} neurons")

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "graph.bin.gz").write_bytes(gzip.compress(graph, compresslevel=6))
    (OUT / "neurons.bin.gz").write_bytes(gzip.compress(neurons, compresslevel=6))

    meta = {
        "version": 1,
        "dataset": "FlyWire FAFB v783",
        "neurons": n,
        "connections": int(len(con)),
        "synapses": int(np.abs(w).sum()),
        "graph": {"indptrBytes": int(indptr.nbytes), "postBytes": len(post_bytes), "weightBytes": len(w_bytes)},
        "types": types,
        "superclasses": superclasses,
        "classes": classes,
        "nts": NTS,
        "sides": ["unknown", "left", "right", "center"],
        "groups": groups,
        "sources": {k: v for k, v in SOURCES.items()},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:16s} {f.stat().st_size / 1e6:7.2f} MB")


if __name__ == "__main__":
    sys.exit(main())
