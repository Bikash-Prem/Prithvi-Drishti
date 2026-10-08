"""Application services — domain logic shared by API routes and agents.

Routes stay thin (validate, call a service, serialize); services hold no HTTP
concerns and never fabricate values: anything the system has not measured is
returned as an explicit ``unavailable`` / ``not_assessed`` measure.
"""
