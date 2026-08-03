pyooz
=====

Python bindings for [ooz](https://github.com/powzix/ooz), an open-source Kraken
/ Mermaid / Selkie / Leviathan / LZNA / Bitknit decompressor.

Based on [gooz](https://github.com/oriath-net/gooz), which did the heavy
lifting of porting ooz to Linux/gcc.

**This is not tested throughly. Please don't use for production purposes
without verifying things first.**

Usage
-----

Clone, setup.py install into a venv. Should work OOTB as long as you have
cython and a gcc.

Not on PyPI yet.

You can also use Nix to build or use this library - see default.nix.

Licensing
---------

pyooz is copyright (C) 2020, Serge 'q3k' Bazanski

ooz is copyright (C) 2016, Powzix.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program.  If not, see <http://www.gnu.org/licenses/>.
