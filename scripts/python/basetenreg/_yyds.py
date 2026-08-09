"""YYDS temp mail client for Baseten OTP — reuses qoderreg._yyds primitives.

Wrapper kept local so basetenreg has a stable import path regardless of how
scripts/python is laid out on the runtime machine.
"""
from qoderreg._yyds import yyds_create_inbox, yyds_poll_otp  # noqa: F401

__all__ = ["yyds_create_inbox", "yyds_poll_otp"]
