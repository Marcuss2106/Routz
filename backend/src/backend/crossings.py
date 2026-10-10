"""FRA inventory crossings for the Columbia, SC demo.

Coordinates/road names are REAL (U.S. DOT Crossing Inventory Form 71,
SOUTH CAROLINA / COLUMBIA, public at-grade open crossings, Norfolk Southern).
Blockage predictions derived from them are still simulated estimates.
"""

from __future__ import annotations

from .models import Crossing

FRA_CROSSINGS: list[Crossing] = [
    # Downtown corridor: Greene -> Laurel, exactly collinear.
    # Northbound heading ~= 109 deg-from-east.
    Crossing(id="715869J", dotId="715869J", roadName="Greene St",
             latitude=33.9996626, longitude=-81.0186712,
             railroad="Norfolk Southern", label="Greene St (DOT 715869J)"),
    Crossing(id="715871K", dotId="715871K", roadName="Hampton St",
             latitude=34.0092424, longitude=-81.0224989,
             railroad="Norfolk Southern", label="Hampton St (DOT 715871K)"),
    Crossing(id="715872S", dotId="715872S", roadName="Taylor St",
             latitude=34.0105799, longitude=-81.0230943,
             railroad="Norfolk Southern", label="Taylor St (DOT 715872S)"),
    Crossing(id="715874F", dotId="715874F", roadName="Blanding St",
             latitude=34.0119064, longitude=-81.0236831,
             railroad="Norfolk Southern", label="Blanding St (DOT 715874F)"),
    Crossing(id="715875M", dotId="715875M", roadName="Laurel St",
             latitude=34.0132446, longitude=-81.0242793,
             railroad="Norfolk Southern", label="Laurel St (DOT 715875M)"),
    # Assembly cluster, south of downtown. Southbound heading ~= 201 deg.
    Crossing(id="715621X", dotId="715621X", roadName="Main St",
             latitude=33.9905036, longitude=-81.028736,
             railroad="Norfolk Southern", label="Main St (DOT 715621X)"),
    Crossing(id="715620R", dotId="715620R", roadName="Assembly St",
             latitude=33.9899741, longitude=-81.0304332,
             railroad="Norfolk Southern", label="Assembly St (DOT 715620R)"),
    Crossing(id="716365M", dotId="716365M", roadName="Lincoln St",
             latitude=33.988965, longitude=-81.033601,
             railroad="Norfolk Southern", label="Lincoln St (DOT 716365M)"),
]
